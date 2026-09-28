import { parseQueryResponse } from 'abap-adt-api/build/api/tablecontents.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import { ObjectHandlers } from './ObjectHandlers.js';
import { SourceHandlers } from './SourceHandlers.js';
import { parseToolPayload } from './WorkflowHandlers.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import {
  deriveRapBoNames,
  buildInterfaceViewSource,
  buildProjectionViewSource,
  buildBehaviorDefRootSource,
  buildBehaviorDefProjectionSource,
  buildBehaviorPoolClassSource,
  buildDraftTableSource,
  buildServiceDefinitionSource,
  buildGuiGuide,
  relevantFields,
  type RapBoNames,
  type RapTableField,
} from '../lib/rapBoTemplates.js';

export interface RapBoPreflight {
  blockers: string[];
  warnings: string[];
  fields: RapTableField[];
  existing: {
    interfaceView: boolean;
    projectionView: boolean;
    behaviorPoolClass: boolean;
    serviceDefinition: boolean;
    draftTable: boolean;
    bdefRoot: boolean;
    bdefProjection: boolean;
  };
}

/**
 * rap_bo_scaffold — full RAP Business Object scaffold from an existing DDIC table.
 *
 * Generates: CDS interface (root) view entity, CDS projection (consumption) view entity,
 * behavior definitions for both, an empty managed behavior pool class, an optional draft
 * table, and a service definition. The service binding is returned as a manual guide step
 * (see rapBoTemplates.ts module doc for why) — use the existing rap_publish_binding tool
 * once it is created.
 *
 * Complements rap_binding_details / rap_publish_binding (RapHandlers.ts), which operate on
 * an already-published binding; this tool builds everything that comes before it.
 */
export class RapBoScaffoldHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'rap_bo_scaffold',
        annotations: { title: 'RAP: full Business Object scaffold' },
        description:
          'Scaffold a complete managed RAP Business Object from an existing DDIC table: CDS interface (root) view entity, ' +
          'CDS projection (consumption) view entity, behavior definitions for both, an empty managed behavior pool class, ' +
          'a service definition, and (optionally) a draft table. Field names are read from DD03L and beautified to UpperCamelCase. ' +
          'mode=check: pre-flight only (table/fields lookup, name-collision check). mode=preview (default): pre-flight + all ' +
          'generated sources + an ordered guide for the steps this tool cannot do (service binding creation, UI annotation tuning). ' +
          'mode=deploy: also creates and activates every object via ADT, in RAP dependency order (interface view -> [draft table] ' +
          '-> root behavior definition -> behavior pool class -> projection view -> projection behavior definition -> service ' +
          'definition; the root behavior definition must be active before the behavior pool class activates, or SAP rejects the ' +
          'class with "no behavior definition for <view>"). The service binding (SRVB) is never auto-created — see the guide for that step, then use ' +
          'rap_publish_binding to publish it. Complements rap_binding_details/rap_publish_binding, which operate on an existing binding.',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Source DDIC table to build the BO on, e.g. ZCUSTORDER' },
            name: { type: 'string', description: 'Base name for generated artifacts (default: table name without its Z/Y prefix), e.g. CUSTORDER' },
            description: { type: 'string', description: 'Short description used on all generated objects (default: "RAP BO for <table>")' },
            draft: { type: 'boolean', description: 'Include draft handling (draft table + draft actions). Default false — see guide caveat when true.' },
            serviceVersion: { type: 'string', description: 'OData version for naming/guide only (SRVB is not auto-created). Default V4', enum: ['V4', 'V2'] },
            mode: { type: 'string', description: 'check | preview (default) | deploy', enum: ['check', 'preview', 'deploy'] },
            package: { type: 'string', description: 'deploy: package ($TMP allowed)' },
            transport: { type: 'string', description: 'deploy: transport request (non-$TMP)' },
            interfaceView: { type: 'string', description: 'Override: CDS interface (root) view entity name (default ZI_<name>)' },
            projectionView: { type: 'string', description: 'Override: CDS projection view entity name (default ZC_<name>)' },
            behaviorPoolClass: { type: 'string', description: 'Override: behavior pool class name (default ZBP_<name>)' },
            serviceDefinition: { type: 'string', description: 'Override: service definition name (default ZSD_<name>)' },
            serviceBinding: { type: 'string', description: 'Override: service binding name for the guide text only (default ZUI_<name>_O4/_O2)' },
            draftTable: { type: 'string', description: 'Override: draft table name (default <table>D, max 16 chars)' },
          },
          required: ['table'],
        },
      },
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'rap_bo_scaffold': return this.handleScaffold(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  // ─── SQL helper (same pattern as BoApprovalHandlers.sqlRows) ───────────────

  protected async sqlRows(sql: string, limit = 400): Promise<any[]> {
    const h = (this.adtclient as any).h;
    const res = await this.withSession(async () => {
      const response = await h.request('/sap/bc/adt/datapreview/freestyle', {
        qs: { rowNumber: limit },
        headers: { Accept: 'application/*', 'Content-Type': 'text/plain' },
        method: 'POST',
        body: sql,
      });
      return parseQueryResponse(response.body) as any;
    });
    return (res?.values || []) as any[];
  }

  // Runs a query and tells apart "ran fine, found nothing" from "the query itself failed"
  // (connection drop, TLS error, syntax error, auth expiry, ...). Swallowing every exception
  // here used to turn a real connectivity error into a misleading "table not found" blocker —
  // found the hard way via a live TLS failure during testing. Callers get both the rows and
  // the error message (if any) and decide what to report.
  private async queryRows(sql: string): Promise<{ rows: any[]; error?: string }> {
    try {
      return { rows: await this.sqlRows(sql) };
    } catch (e: any) {
      return { rows: [], error: formatError('query', e) };
    }
  }

  protected async collectPreflight(names: RapBoNames): Promise<RapBoPreflight> {
    const q = (s: string) => s.replace(/'/g, "''");

    const fieldsResult = await this.queryRows(
      `SELECT fieldname, keyflag, rollname, inttype, datatype, reffield, leng, decimals FROM dd03l ` +
      `WHERE tabname = '${q(names.table)}' AND as4local = 'A' ORDER BY position`
    );
    const rows = fieldsResult.rows;
    const fields: RapTableField[] = rows.map(r => ({
      fieldName: String(r.FIELDNAME || '').toUpperCase(),
      isKey: String(r.KEYFLAG || '').toUpperCase() === 'X',
      rollname: r.ROLLNAME ? String(r.ROLLNAME) : undefined,
      intType: r.INTTYPE ? String(r.INTTYPE) : undefined,
      dataType: r.DATATYPE ? String(r.DATATYPE) : undefined,
      refField: r.REFFIELD ? String(r.REFFIELD) : undefined,
      length: r.LENG ? Number(r.LENG) : undefined,
      decimals: r.DECIMALS ? Number(r.DECIMALS) : undefined,
    }));

    const namesToCheck = [names.interfaceView, names.projectionView, names.behaviorPoolClass, names.serviceDefinition, names.draftTable]
      .filter(Boolean) as string[];
    const inClause = namesToCheck.map(n => `'${q(n)}'`).join(', ');
    const tadirResult = namesToCheck.length
      ? await this.queryRows(`SELECT object, obj_name FROM tadir WHERE pgmid = 'R3TR' AND obj_name IN (${inClause})`)
      : { rows: [] as any[] };
    const tadir = tadirResult.rows;
    const exists = (n?: string, object?: string) => !!n && tadir.some(r =>
      String(r.OBJ_NAME).toUpperCase() === n.toUpperCase() && (!object || String(r.OBJECT).toUpperCase() === object));

    const blockers: string[] = [];
    const warnings: string[] = [];
    const rel = relevantFields(fields);
    if (fieldsResult.error) {
      blockers.push(`Could not read ${names.table} from DD03L — this looks like a connection or query error, not a missing table: ${fieldsResult.error}`);
    } else if (rel.length === 0) {
      blockers.push(`Table ${names.table} not found in DD03L (as4local = 'A') — check the table name and that it is active.`);
    } else if (!rel.some(f => f.isKey)) {
      blockers.push(`Table ${names.table} has no key fields besides MANDT — a CDS root view entity needs at least one key.`);
    }
    if (tadirResult.error) {
      warnings.push(`Could not check TADIR for existing objects — existence warnings below may be incomplete: ${tadirResult.error}`);
    }

    if (exists(names.interfaceView, 'DDLS')) warnings.push(`${names.interfaceView} already exists — deploy overwrites its source.`);
    if (exists(names.projectionView, 'DDLS')) warnings.push(`${names.projectionView} already exists — deploy overwrites its source.`);
    if (exists(names.behaviorPoolClass)) warnings.push(`${names.behaviorPoolClass} already exists — deploy overwrites its source (any handler methods you added will be lost).`);
    if (exists(names.serviceDefinition)) warnings.push(`${names.serviceDefinition} already exists — deploy overwrites its source.`);
    if (names.draftTable && exists(names.draftTable)) warnings.push(`${names.draftTable} already exists — deploy keeps it unchanged.`);
    if (exists(names.interfaceView, 'BDEF')) warnings.push(`Behavior definition for ${names.interfaceView} already exists — deploy overwrites its source.`);
    if (exists(names.projectionView, 'BDEF')) warnings.push(`Behavior definition for ${names.projectionView} already exists — deploy overwrites its source.`);

    return {
      blockers,
      warnings,
      fields,
      existing: {
        interfaceView: exists(names.interfaceView, 'DDLS'),
        projectionView: exists(names.projectionView, 'DDLS'),
        behaviorPoolClass: exists(names.behaviorPoolClass),
        serviceDefinition: exists(names.serviceDefinition),
        draftTable: !!names.draftTable && exists(names.draftTable),
        bdefRoot: exists(names.interfaceView, 'BDEF'),
        bdefProjection: exists(names.projectionView, 'BDEF'),
      },
    };
  }

  // ─── main ──────────────────────────────────────────────────────────────────

  private async handleScaffold(args: any): Promise<any> {
    let names: RapBoNames;
    try {
      names = deriveRapBoNames(args);
    } catch (e: any) {
      this.fail(`rap_bo_scaffold: ${e.message}`);
    }
    const mode = String(args.mode || 'preview');

    await this.notify(`rap_bo_scaffold: pre-flight for ${names!.table} -> ${names!.interfaceView}...`);
    const pre = await this.collectPreflight(names!);

    if (mode === 'check' || pre.blockers.length) {
      return this.success({
        mode: pre.blockers.length && mode !== 'check' ? `${mode} (stopped by blockers)` : 'check',
        names: names!,
        preflight: pre,
      });
    }

    let sources: Record<string, string>;
    try {
      sources = {
        [names!.interfaceView]: buildInterfaceViewSource(names!, pre.fields),
        [names!.projectionView]: buildProjectionViewSource(names!, pre.fields),
        [names!.behaviorPoolClass]: buildBehaviorPoolClassSource(names!),
        [`${names!.interfaceView} (BDEF)`]: buildBehaviorDefRootSource(names!, pre.fields),
        [`${names!.projectionView} (BDEF)`]: buildBehaviorDefProjectionSource(names!),
        [names!.serviceDefinition]: buildServiceDefinitionSource(names!),
      };
      if (names!.draftTable) sources[names!.draftTable] = buildDraftTableSource(names!, pre.fields);
    } catch (e: any) {
      this.fail(`rap_bo_scaffold: ${e.message}`);
    }
    const guide = buildGuiGuide(names!);

    if (mode !== 'deploy') {
      return this.success({
        mode: 'preview',
        names: names!,
        preflight: pre,
        sources: sources!,
        guide,
        next: 'Call again with mode="deploy" and package (and transport) to create and activate everything except the service binding; then follow the guide.',
      });
    }

    const deployed = await this.deploy(args, names!, pre, sources!);
    return this.success({
      mode: 'deploy',
      names: names!,
      preflight: pre,
      steps: deployed.steps,
      guide,
    });
  }

  private async deploy(
    args: any,
    names: RapBoNames,
    pre: RapBoPreflight,
    sources: Record<string, string>,
  ): Promise<{ steps: Array<{ step: string; ok: boolean; detail?: string }> }> {
    if (!args.package) this.fail('rap_bo_scaffold(deploy): package is required ($TMP allowed).');
    const pkg = String(args.package).toUpperCase();
    if (pkg !== '$TMP' && !args.transport) this.fail('rap_bo_scaffold(deploy): transport is required for non-$TMP packages.');
    const transport = args.transport ? String(args.transport).toUpperCase() : undefined;

    const objects = new ObjectHandlers(this.adtclient);
    const source = new SourceHandlers(this.adtclient);
    for (const h of [objects, source]) {
      const self = this as any;
      if (self._notify) h.setNotify(self._notify);
      if (self._elicit) h.setElicit(self._elicit);
    }

    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    const run = async (step: string, fn: () => Promise<any>): Promise<void> => {
      await this.notify(`rap_bo_scaffold: ${step}...`);
      try {
        const r = await fn();
        const payload = parseToolPayload(r);
        if (payload?.activated === false || payload?.success === false) {
          throw new Error(JSON.stringify(payload.errors || payload.messages || payload));
        }
        steps.push({ step, ok: true, detail: payload?.message });
      } catch (e: any) {
        steps.push({ step, ok: false, detail: e?.message || String(e) });
        throw new Error(`${step}: ${e?.message || e}`);
      }
    };

    const createWriteActivate = async (name: string, type: string, source_: string, description: string, existsAlready: boolean): Promise<void> => {
      if (!existsAlready) {
        await run(`create ${type} ${name}`, () => objects.validateAndHandle('abap_create',
          { name, type, description, package: pkg, transport }));
      }
      await run(`write ${type} ${name}`, () => source.validateAndHandle('abap_set_source',
        { name, type, source: source_, transport }));
      await run(`activate ${type} ${name}`, () => objects.validateAndHandle('abap_activate', { name, type }));
    };

    try {
      // 1. CDS interface (root) view entity
      await createWriteActivate(names.interfaceView, 'DDLS', sources[names.interfaceView], names.description, pre.existing.interfaceView);

      // 2. draft table — must exist before the root BDEF's "draft table" clause activates
      if (names.draftTable) {
        if (!pre.existing.draftTable) {
          await createWriteActivate(names.draftTable, 'TABL', sources[names.draftTable], `Draft table for ${names.interfaceView}`, false);
        } else {
          steps.push({ step: `table ${names.draftTable} already exists — kept`, ok: true });
        }
      }

      // 3. behavior definition (root) — object name equals the interface view name, type BDEF.
      // Must come BEFORE the behavior pool class: SAP's class activation for a "FOR BEHAVIOR OF <view>"
      // class checks that a behavior definition already exists and is active for that view — activating
      // the class first fails with "There is no behavior definition for <view>".
      await createWriteActivate(names.interfaceView, 'BDEF', sources[`${names.interfaceView} (BDEF)`], `Behavior def for ${names.interfaceView}`, pre.existing.bdefRoot);

      // 4. empty behavior pool class — now that the root BDEF exists and is active
      await createWriteActivate(names.behaviorPoolClass, 'CLAS', sources[names.behaviorPoolClass], `Behavior pool for ${names.interfaceView}`, pre.existing.behaviorPoolClass);

      // 5. CDS projection (consumption) view entity
      await createWriteActivate(names.projectionView, 'DDLS', sources[names.projectionView], names.description, pre.existing.projectionView);

      // 6. behavior definition (projection) — object name equals the projection view name, type BDEF
      await createWriteActivate(names.projectionView, 'BDEF', sources[`${names.projectionView} (BDEF)`], `Behavior def for ${names.projectionView}`, pre.existing.bdefProjection);

      // 7. service definition
      await createWriteActivate(names.serviceDefinition, 'SRVD', sources[names.serviceDefinition], names.description, pre.existing.serviceDefinition);
    } catch (error: any) {
      this.fail(
        `rap_bo_scaffold(deploy) stopped: ${error?.message || error}\n` +
        steps.map(s => `${s.ok ? 'OK ' : 'ERR'} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`).join('\n') +
        `\n\nThe service binding is never auto-created — see the guide for that manual step.`
      );
    }

    return { steps };
  }
}
