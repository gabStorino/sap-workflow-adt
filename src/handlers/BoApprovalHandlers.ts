import { parseQueryResponse } from 'abap-adt-api/build/api/tablecontents.js';
import { BaseHandler } from './BaseHandler.js';
import { ObjectHandlers } from './ObjectHandlers.js';
import { SourceHandlers } from './SourceHandlers.js';
import { parseToolPayload } from './WorkflowHandlers.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import { buildFunctionModuleUrl, buildObjectUrl } from '../lib/urlBuilder.js';
import {
  deriveBoApprovalNames,
  buildApprovalTableSource,
  buildUpdateFmSource,
  buildRaiseEventFmSource,
  buildBorMethodsSource,
  buildGuiGuide,
  resolveDisplay,
  mainTableOf,
  type BoApprovalNames,
  type BoKeyField,
} from '../lib/boApprovalTemplates.js';

export interface PreflightRaw {
  supertypeExists: boolean;
  subtypeExists: boolean;
  keys: BoKeyField[];
  cdFromSwec: string[];
  cdFromTcdob: string[];
  prefixes: Array<{ LEAD_NR?: string; SYSID?: string; MANDT?: string }>;
  rfcDests: string[];
  existing: { table: boolean; functionGroup: boolean; updateFm: boolean; raiseFm: boolean };
}

export interface PreflightResult {
  blockers: string[];
  warnings: string[];
  cdObject?: string;
  cdCandidates: string[];
  keys: BoKeyField[];
  existing: PreflightRaw['existing'];
}

/** Turn raw lookups into blockers/warnings. Pure — unit tested. */
export function summarizePreflight(raw: PreflightRaw, names: BoApprovalNames, opts: { client?: string; cdObject?: string }): PreflightResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!raw.supertypeExists) blockers.push(`BO ${names.supertype} not found in TOJTB.`);
  if (raw.supertypeExists && raw.keys.length === 0) blockers.push(`BO ${names.supertype} has no key fields in SWOTDV (VERBTYPE = K).`);
  if (raw.subtypeExists) warnings.push(`BO ${names.subtype} already exists — SWO1 steps become "modify" instead of "create subtype".`);

  const cdCandidates = Array.from(new Set([...raw.cdFromSwec, ...raw.cdFromTcdob]));
  const cdObject = opts.cdObject ? opts.cdObject.toUpperCase() : cdCandidates[0];
  if (!cdObject) warnings.push('No change document object found for the main table — pass cdObject or use the raise-event FM in a save exit/BAdI.');
  else if (!opts.cdObject && cdCandidates.length > 1) warnings.push(`Several change document objects fit (${cdCandidates.join(', ')}); using ${cdObject}.`);

  if (opts.client) {
    const client = opts.client.padStart(3, '0');
    if (!raw.prefixes.some(p => String(p.MANDT || '') === client)) {
      warnings.push(`No workflow prefix number (T78NR/OOW4) for client ${client}: no TS/WS can be saved there until one is created.`);
    }
    if (!raw.rfcDests.includes(`WORKFLOW_LOCAL_${client}`)) {
      warnings.push(`RFC destination WORKFLOW_LOCAL_${client} missing (SWU3 not done in client ${client}): the event finds its receiver but no workflow starts. Needs an admin (WF-BATCH password).`);
    }
  } else {
    warnings.push('client not given: prefix number (T78NR) and SWU3 RFC destination were not checked for the GUI client.');
  }

  if (raw.existing.table) warnings.push(`Table ${names.table} already exists — deploy keeps it unchanged.`);
  if (raw.existing.updateFm) warnings.push(`FM ${names.updateFm} already exists — deploy overwrites its source.`);

  return { blockers, warnings, cdObject, cdCandidates, keys: raw.keys, existing: raw.existing };
}

/**
 * wf_bo_approval_scaffold — approve/reject workflow on a Z subtype of any BOR object.
 */
export class BoApprovalHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'wf_bo_approval_scaffold',
        description:
          'Scaffold a classic SAP Business Workflow for approve/reject on a Z SUBTYPE of any BOR object ' +
          '(e.g. BUS2012 → ZCUST_PO): change document (SWEC) raises Z<BO>.<EVENT> on save → dialog step displays the document → ' +
          'user decision Approve/Reject → container operation STATUS=A/R → background step writes a Z log table. ' +
          'Reads SWOTDV/DD03L for the BO key, suggests the change document object (SWECDOBJ/TCDOB), checks prefix numbers (T78NR) ' +
          'and the SWU3 RFC destination for the GUI client. ' +
          'mode=check: pre-flight only. mode=preview (default): pre-flight + all generated sources (Z table, update FM, optional raise-event FM, ' +
          'BOR method code) + ordered SAP GUI guide. mode=deploy: also creates and activates the Z table, function group and FMs via ADT ' +
          '(FMs activated together with their group and verified not inactive). ' +
          'BOR subtype (SWO1), SWEC entry, tasks and WS template (PFTC/SWDD) cannot be created through ADT — they are returned as the guide. ' +
          'Only the BUS2012 display preset is verified end to end; other presets are marked verified=false.',
        annotations: { title: 'Workflow: BO subtype approval scaffold' },
        inputSchema: {
          type: 'object',
          properties: {
            supertype: { type: 'string', description: 'Standard BOR object type, e.g. BUS2012 (max 10 chars)' },
            subtype: { type: 'string', description: 'Z subtype to create in SWO1, e.g. ZCUST_PO (max 10 chars)' },
            event: { type: 'string', description: 'Custom event name (default ZCHANGED), e.g. POCHANGED' },
            mode: { type: 'string', description: 'check | preview (default) | deploy', enum: ['check', 'preview', 'deploy'] },
            client: { type: 'string', description: 'SAP GUI client where the workflow will run (e.g. 500). Enables the T78NR and SWU3 RFC checks.' },
            cdObject: { type: 'string', description: 'Override: change document object for SWEC (e.g. EINKBELEG)' },
            package: { type: 'string', description: 'deploy: package ($TMP allowed)' },
            transport: { type: 'string', description: 'deploy: transport request (non-$TMP)' },
            includeRaiseFm: { type: 'boolean', description: 'Also generate/deploy the SAP_WAPI_CREATE_EVENT FM for a save exit/BAdI (default false; SWEC needs no code)' },
            table: { type: 'string', description: 'Override: Z log table (default Z<base>_APR, max 16)' },
            functionGroup: { type: 'string', description: 'Override: function group (default Z<base>_WF)' },
            updateFm: { type: 'string', description: 'Override: update FM (default Z<base>_UPD_STATUS)' },
            raiseFm: { type: 'string', description: 'Override: raise-event FM (default Z<base>_RAISE_EVT)' },
            wfAbbrev: { type: 'string', description: 'Override: WS abbreviation (max 12)' },
            tsDisplayAbbrev: { type: 'string', description: 'Override: display TS abbreviation (max 12)' },
            tsUpdateAbbrev: { type: 'string', description: 'Override: background TS abbreviation (max 12)' },
            displayFm: { type: 'string', description: 'Override: FM used to display the document (you complete the parameter mapping)' },
            displayTcode: { type: 'string', description: 'Override: display transaction (SET PARAMETER ID + CALL TRANSACTION ... AND SKIP FIRST SCREEN)' },
            displayParamIds: { type: 'string', description: 'With displayTcode: comma-separated parameter IDs in key order, e.g. RBN,GJR' },
          },
          required: ['supertype', 'subtype']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'wf_bo_approval_scaffold': return this.handleScaffold(args);
      default: this.fail(`Unknown tool: ${toolName}`);
    }
  }

  // ─── SQL helper (datapreview/freestyle, same as abap_query) ────────────────

  protected async sqlRows(sql: string, limit = 200): Promise<any[]> {
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

  private async safeRows(sql: string): Promise<any[]> {
    try { return await this.sqlRows(sql); } catch (_) { return []; }
  }

  protected async collectPreflight(names: BoApprovalNames, includeRaise: boolean): Promise<PreflightRaw> {
    const q = (s: string) => s.replace(/'/g, "''");
    const tojtb = await this.safeRows(`SELECT name FROM tojtb WHERE name = '${q(names.supertype)}' OR name = '${q(names.subtype)}'`);
    const has = (n: string) => tojtb.some(r => String(r.NAME).toUpperCase() === n);

    const keyRows = await this.safeRows(
      `SELECT verb, refstruct, reffield, editorder FROM swotdv WHERE objtype = '${q(names.supertype)}' AND verbtype = 'K'`
    );
    keyRows.sort((a, b) => Number(a.EDITORDER || 0) - Number(b.EDITORDER || 0));
    const keys: BoKeyField[] = [];
    for (const r of keyRows) {
      const dd = await this.safeRows(
        `SELECT rollname, inttype, leng FROM dd03l WHERE tabname = '${q(r.REFSTRUCT)}' AND fieldname = '${q(r.REFFIELD)}' AND as4local = 'A'`
      );
      keys.push({
        verb: String(r.VERB),
        refStruct: String(r.REFSTRUCT),
        refField: String(r.REFFIELD),
        rollname: dd[0]?.ROLLNAME ? String(dd[0].ROLLNAME) : undefined,
        intType: dd[0]?.INTTYPE,
        length: dd[0]?.LENG ? Number(dd[0].LENG) : undefined,
      });
    }

    const swec = await this.safeRows(`SELECT cdobjectcl FROM swecdobj WHERE objtype = '${q(names.supertype)}'`);
    const main = mainTableOf(keys);
    const tcdob = main
      ? await this.safeRows(`SELECT object FROM tcdob WHERE tabname = '${q(main)}' AND multcase = ' '`)
      : [];

    const prefixes = await this.safeRows('SELECT lead_nr, sysid, mandt FROM t78nr');
    const rfc = await this.safeRows(`SELECT rfcdest FROM rfcdes WHERE rfcdest LIKE 'WORKFLOW_LOCAL%'`);

    const tadir = await this.safeRows(
      `SELECT object, obj_name FROM tadir WHERE pgmid = 'R3TR' AND ( ( object = 'TABL' AND obj_name = '${q(names.table)}' ) OR ( object = 'FUGR' AND obj_name = '${q(names.functionGroup)}' ) )`
    );
    const fms = await this.safeRows(
      `SELECT funcname FROM tfdir WHERE funcname = '${q(names.updateFm)}'${includeRaise ? ` OR funcname = '${q(names.raiseFm)}'` : ''}`
    );

    return {
      supertypeExists: has(names.supertype),
      subtypeExists: has(names.subtype),
      keys,
      cdFromSwec: Array.from(new Set(swec.map(r => String(r.CDOBJECTCL)).filter(Boolean))),
      cdFromTcdob: Array.from(new Set(tcdob.map(r => String(r.OBJECT)).filter(Boolean))),
      prefixes,
      rfcDests: rfc.map(r => String(r.RFCDEST)),
      existing: {
        table: tadir.some(r => r.OBJECT === 'TABL'),
        functionGroup: tadir.some(r => r.OBJECT === 'FUGR'),
        updateFm: fms.some(r => r.FUNCNAME === names.updateFm),
        raiseFm: fms.some(r => r.FUNCNAME === names.raiseFm),
      },
    };
  }

  // ─── main ──────────────────────────────────────────────────────────────────

  private async handleScaffold(args: any): Promise<any> {
    let names: BoApprovalNames;
    try {
      names = deriveBoApprovalNames(args);
    } catch (e: any) {
      this.fail(`wf_bo_approval_scaffold: ${e.message}`);
    }
    const mode = String(args.mode || 'preview');
    const includeRaise = args.includeRaiseFm === true || args.includeRaiseFm === 'true';

    await this.notify(`wf_bo_approval_scaffold: pre-flight for ${names!.supertype} → ${names!.subtype}…`);
    const raw = await this.collectPreflight(names!, includeRaise);
    const pre = summarizePreflight(raw, names!, { client: args.client, cdObject: args.cdObject });

    if (mode === 'check' || pre.blockers.length) {
      return this.success({
        mode: pre.blockers.length && mode !== 'check' ? `${mode} (stopped by blockers)` : 'check',
        names: names!,
        preflight: pre,
      });
    }

    const display = resolveDisplay(args, names!.supertype);
    const sources: Record<string, string> = {
      [names!.table]: buildApprovalTableSource(names!, pre.keys),
      [names!.updateFm]: buildUpdateFmSource(names!, pre.keys),
    };
    if (includeRaise) sources[names!.raiseFm] = buildRaiseEventFmSource(names!, pre.keys);
    const borMethodsSource = buildBorMethodsSource(names!, pre.keys, display);
    const guide = buildGuiGuide(names!, { cdObject: pre.cdObject, client: args.client, keys: pre.keys, display });

    if (mode !== 'deploy') {
      return this.success({
        mode: 'preview',
        names: names!,
        preflight: pre,
        display,
        sources,
        borMethodsSource,
        guide,
        next: 'Call again with mode="deploy" and package (and transport) to create the table, function group and FMs; then follow the guide.',
      });
    }

    const deployed = await this.deploy(args, names!, pre, sources, includeRaise);
    return this.success({
      mode: 'deploy',
      names: names!,
      preflight: pre,
      display,
      steps: deployed.steps,
      stillInactive: deployed.stillInactive,
      borMethodsSource,
      guide,
    });
  }

  private async deploy(
    args: any,
    names: BoApprovalNames,
    pre: PreflightResult,
    sources: Record<string, string>,
    includeRaise: boolean,
  ): Promise<{ steps: Array<{ step: string; ok: boolean; detail?: string }>; stillInactive: string[] }> {
    if (!args.package) this.fail('wf_bo_approval_scaffold(deploy): package is required ($TMP allowed).');
    const pkg = String(args.package).toUpperCase();
    if (pkg !== '$TMP' && !args.transport) this.fail('wf_bo_approval_scaffold(deploy): transport is required for non-$TMP packages.');
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
      await this.notify(`wf_bo_approval_scaffold: ${step}…`);
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

    const fms = [names.updateFm, ...(includeRaise ? [names.raiseFm] : [])];
    try {
      // 1. Z table
      if (!pre.existing.table) {
        await run(`create table ${names.table}`, () => objects.validateAndHandle('abap_create',
          { name: names.table, type: 'TABL', description: `WF ${names.subtype}: aprovacao/rejeicao`, package: pkg, transport }));
        await run(`write table ${names.table}`, () => source.validateAndHandle('abap_set_source',
          { name: names.table, type: 'TABL', source: sources[names.table], transport }));
        await run(`activate table ${names.table}`, () => objects.validateAndHandle('abap_activate', { name: names.table, type: 'TABL' }));
      } else {
        steps.push({ step: `table ${names.table} already exists — kept`, ok: true });
      }

      // 2. function group
      if (!pre.existing.functionGroup) {
        await run(`create function group ${names.functionGroup}`, () => objects.validateAndHandle('abap_create',
          { name: names.functionGroup, type: 'FUGR/F', description: `WF ${names.subtype}: aprovacao`, package: pkg, transport }));
      }

      // 3. function modules (package = parent function group for FUGR/FF)
      for (const fm of fms) {
        const exists = fm === names.updateFm ? pre.existing.updateFm : pre.existing.raiseFm;
        if (!exists) {
          await run(`create FM ${fm}`, () => objects.validateAndHandle('abap_create', {
            name: fm, type: 'FUGR/FF', package: names.functionGroup, transport,
            description: fm === names.updateFm ? `WF ${names.subtype}: grava status em ${names.table}` : `WF ${names.subtype}: dispara ${names.event}`,
          }));
        }
        await run(`write FM ${fm}`, () => source.validateAndHandle('abap_set_source',
          { name: fm, type: 'FUGR/FF', fugr: names.functionGroup, source: sources[fm], transport }));
      }

      // 4. activate group + FMs together (activating only the FUGR can leave the FMs inactive)
      await this.notify('wf_bo_approval_scaffold: activating function group and FMs…');
      const groupUrl = buildObjectUrl(names.functionGroup, 'FUGR/F');
      const refs = [
        { 'adtcore:uri': groupUrl, 'adtcore:type': 'FUGR/F', 'adtcore:name': names.functionGroup, 'adtcore:parentUri': '' },
        ...fms.map(fm => ({
          'adtcore:uri': buildFunctionModuleUrl(names.functionGroup, fm),
          'adtcore:type': 'FUGR/FF',
          'adtcore:name': fm,
          'adtcore:parentUri': groupUrl,
        })),
      ];
      const act: any = await this.withSession(() => (this.adtclient as any).activate(refs, true));
      if (act && act.success === false) {
        const msgs = (act.messages || []).map((m: any) => m.shortText || m.objDescr || JSON.stringify(m)).join(' | ');
        steps.push({ step: 'activate function group + FMs', ok: false, detail: msgs });
        throw new Error(`activation failed: ${msgs}`);
      }
      steps.push({ step: 'activate function group + FMs', ok: true });
    } catch (error: any) {
      this.fail(
        `wf_bo_approval_scaffold(deploy) stopped: ${error?.message || error}\n` +
        steps.map(s => `${s.ok ? 'OK ' : 'ERR'} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')
      );
    }

    // 5. verify nothing we own is still inactive
    let stillInactive: string[] = [];
    try {
      const inactive: any[] = await this.withSession(() => (this.adtclient as any).inactiveObjects());
      const ours = new Set([names.table, names.functionGroup, ...fms]);
      stillInactive = (inactive || [])
        .map(r => String(r?.object?.['adtcore:name'] || '').toUpperCase())
        .filter(n => ours.has(n));
    } catch (e: any) {
      steps.push({ step: 'check inactive objects', ok: false, detail: formatError('inactiveObjects', e) });
    }
    if (stillInactive.length) steps.push({ step: 'objects still inactive', ok: false, detail: stillInactive.join(', ') });
    return { steps, stillInactive };
  }
}
