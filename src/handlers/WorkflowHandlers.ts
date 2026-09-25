import { BaseHandler } from './BaseHandler.js';
import { ObjectHandlers } from './ObjectHandlers.js';
import { SourceHandlers } from './SourceHandlers.js';
import { TestHandlers } from './TestHandlers.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError, parseAdtError } from '../lib/errors.js';
import {
  deriveWfNames,
  buildWfClassSource,
  buildWfExceptionSource,
  buildWfTestSource,
  buildClusterTableSource,
  buildMessageClassXml,
  parseMessageClassXml,
  mergeMessages,
  normalizeMsgNo,
  buildPackageXml,
  wfDefaultMessages,
  type WfMessage,
} from '../lib/wfTemplates.js';

/** Extract the JSON object a handler returned inside content[0].text (undefined if not JSON). */
export function parseToolPayload(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch (_) { return undefined; }
}

/**
 * sap-workflow-adt extensions:
 *   - package_create      : create a package through the ADT packages API (v2 XML)
 *   - msag_set_messages   : write messages of a message class through the ADT message class API
 *   - wf_class_scaffold   : generate (and optionally deploy) an IF_WORKFLOW class + CX_BO_* exceptions
 */
export class WorkflowHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'package_create',
        description:
          'Create an ABAP package (DEVC) through the ADT packages API. ' +
          'Top-level packages need softwareComponent (default HOME) and optionally transportLayer; ' +
          'sub-packages pass superPackage. A transport REQUEST is required for non-$ packages: create it first with ' +
          'transport_create(objectName=<package>, objectType=DEVC, package=<package>) — the anchor object may not exist yet. ' +
          'Local packages start with $ and need no transport.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Package name, e.g. ZWF_ZIP (max 30 chars)' },
            description: { type: 'string', description: 'Short description (max 60 chars)' },
            superPackage: { type: 'string', description: 'Parent package for a sub-package. Omit for a top-level package.' },
            softwareComponent: { type: 'string', description: 'Software component (default HOME for customer developments)' },
            transportLayer: { type: 'string', description: 'Transport layer (e.g. ZS4H). Omit for local/unrecorded layers.' },
            packageType: { type: 'string', description: 'development (default), structure or main', enum: ['development', 'structure', 'main'] },
            transport: { type: 'string', description: 'Transport REQUEST number (e.g. S4HK902118). Required unless the package starts with $.' }
          },
          required: ['name', 'description']
        }
      },
      {
        name: 'msag_set_messages',
        description:
          'Create or update messages (T100) of an existing message class through the ADT message class API ' +
          '(lock → PUT → unlock), in the master language. Existing messages are kept and the given ones are ' +
          'added/replaced by number (mode=merge, default); mode=replace writes exactly the given list. ' +
          'Create the message class first with abap_create(type=MSAG). ' +
          'Translations are not supported by ADT — use SE63 for other languages. ' +
          'Never write T100/T100U directly: ADT then fails to read the class (HTTP 500).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Message class name, e.g. ZWF_ZIP' },
            messages: {
              type: 'array',
              description: 'Messages: [{ "number": "001", "text": "ZIP &1 not found", "selfExplanatory": true }]. Text max 73 chars; placeholders &1..&4.'
            },
            mode: { type: 'string', description: 'merge (default) or replace', enum: ['merge', 'replace'] },
            transport: { type: 'string', description: 'Transport request/task. Required unless the message class is in $TMP.' }
          },
          required: ['name', 'messages']
        }
      },
      {
        name: 'wf_class_scaffold',
        description:
          'Generate an SAP Business Workflow-ready ABAP class following "ABAP Development for SAP Business Workflow" ch. 7: ' +
          'IF_WORKFLOW + IF_SERIALIZABLE_OBJECT, GUID key (CHAR32), private instantiation with CREATE/GET_INSTANCE/DELETE_INSTANCE, ' +
          'instance management via BI_PERSISTENT~FIND_BY_LPOR, data cluster persistence (GUID-22 cluster ID), ' +
          'exceptions inheriting CX_BO_ERROR / CX_BO_TEMPORARY with T100 texts, workflow events CREATED/CHANGED/DELETED, ' +
          'and an ABAP Unit test include. ' +
          'mode=preview (default) only returns the sources. mode=deploy creates everything in SAP in order: ' +
          'message class + messages, cluster table (if missing), exceptions, class, test include, activation, unit tests. ' +
          'Business logic is left as TODO comments inside the generated methods.',
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Class name, e.g. ZCL_WF_ZIP' },
            description: { type: 'string', description: 'Class short description' },
            mode: { type: 'string', description: 'preview (default) or deploy', enum: ['preview', 'deploy'] },
            package: { type: 'string', description: 'Package for all objects (deploy). $TMP allowed.' },
            transport: { type: 'string', description: 'Transport REQUEST number (deploy, non-$TMP).' },
            errorClass: { type: 'string', description: 'Override: permanent exception class (default ZCX_<base>_ERROR)' },
            tempClass: { type: 'string', description: 'Override: temporary exception class (default ZCX_<base>_TEMP)' },
            messageClass: { type: 'string', description: 'Override: message class (default Z<base>, max 20 chars)' },
            clusterTable: { type: 'string', description: 'Override: data cluster table (default ZWF_XML_INDX, shared by all classes)' },
            relid: { type: 'string', description: 'Override: 2-char cluster area (default derived from the class name)' },
            keyField: { type: 'string', description: 'Override: key attribute name (default OBJECT_ID)' },
            runTests: { type: 'boolean', description: 'deploy: run the generated ABAP Unit tests at the end (default true)' }
          },
          required: ['className', 'description']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'package_create':    return this.handlePackageCreate(args);
      case 'msag_set_messages': return this.handleSetMessages(args);
      case 'wf_class_scaffold': return this.handleScaffold(args);
      default: this.fail(`Unknown tool: ${toolName}`);
    }
  }

  // ─── package_create ─────────────────────────────────────────────────────────

  private async handlePackageCreate(args: any): Promise<any> {
    const name = String(args.name).toUpperCase();
    const isLocal = name.startsWith('$');
    if (name.length > 30) this.fail(`package_create: "${name}" is longer than 30 characters`);
    if (!isLocal && !args.transport) {
      this.fail(
        `package_create(${name}): transport is required for transportable packages. ` +
        `Create one with transport_create(objectName="${name}", objectType="DEVC", package="${name}") and pass the REQUEST number.`
      );
    }

    const body = buildPackageXml({
      name,
      description: args.description,
      superPackage: args.superPackage,
      softwareComponent: isLocal ? 'LOCAL' : args.softwareComponent,
      transportLayer: args.transportLayer,
      packageType: args.packageType,
    });

    const h = (this.adtclient as any).h;
    const qs: Record<string, string> = {};
    if (args.transport) qs.corrNr = String(args.transport).toUpperCase();

    try {
      await this.withSession(() =>
        h.request('/sap/bc/adt/packages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.sap.adt.packages.v2+xml',
            Accept: 'application/vnd.sap.adt.packages.v2+xml, application/vnd.sap.adt.packages.v1+xml',
          },
          body,
          qs,
        })
      );
      return this.success({
        message: `Created package ${name}${args.superPackage ? ` under ${String(args.superPackage).toUpperCase()}` : ''}` +
          `${args.transport ? ` on transport ${String(args.transport).toUpperCase()}` : ''}.`,
        name,
        type: 'DEVC',
      });
    } catch (error: any) {
      this.fail(formatError(`package_create(${name})`, error));
    }
  }

  // ─── msag_set_messages ──────────────────────────────────────────────────────

  private async handleSetMessages(args: any): Promise<any> {
    const name = String(args.name).toUpperCase();
    const url = `/sap/bc/adt/messageclass/${encodeURIComponent(name.toLowerCase())}`;
    let incoming: WfMessage[];
    try {
      const raw = typeof args.messages === 'string' ? JSON.parse(args.messages) : args.messages;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('messages must be a non-empty array');
      incoming = raw.map((m: any) => ({
        number: normalizeMsgNo(m.number ?? m.msgno ?? m.msgnr),
        text: String(m.text ?? m.msgtext ?? ''),
        selfExplanatory: m.selfExplanatory !== false,
      }));
    } catch (e: any) {
      this.fail(`msag_set_messages(${name}): invalid messages — ${e.message}`);
    }

    const h = (this.adtclient as any).h;
    let written: WfMessage[] = [];
    let lockHandle: string | null = null;

    const doWrite = async (): Promise<void> => {
      const current = await h.request(url, { method: 'GET', headers: { Accept: 'application/vnd.sap.adt.mc.messageclass+xml, application/xml, */*' } });
      const parsed = parseMessageClassXml(String(current.body ?? ''));
      written = args.mode === 'replace' ? mergeMessages([], incoming) : mergeMessages(parsed.messages, incoming);
      const body = buildMessageClassXml({
        name,
        description: parsed.description || name,
        masterLanguage: parsed.masterLanguage,
        packageName: parsed.packageName,
        messages: written,
      });

      const r = await this.adtclient.lock(url);
      lockHandle = r.LOCK_HANDLE;
      try {
        const corrNr = this.requireTransport(r, args.transport, name);
        const qs: Record<string, string> = { lockHandle: lockHandle! };
        if (corrNr) qs.corrNr = corrNr;
        const put = (contentType: string) => h.request(url, {
          method: 'PUT',
          headers: { 'Content-Type': contentType, Accept: '*/*' },
          body,
          qs,
        });
        try {
          await put('application/vnd.sap.adt.mc.messageclass+xml; charset=utf-8');
        } catch (e: any) {
          // Older releases register the plain XML media type only
          const status = e?.response?.status ?? e?.err;
          if (status === 415 || /415|unsupported media/i.test(e?.message || '')) {
            await put('application/xml; charset=utf-8');
          } else {
            throw e;
          }
        }
      } catch (err) {
        try { await this.adtclient.unLock(url, lockHandle!); } catch (_) {}
        lockHandle = null;
        throw err;
      }
      await this.adtclient.unLock(url, lockHandle!);
      lockHandle = null;
    };

    try {
      await this.withSession(doWrite);
      return this.success({
        message: `Message class ${name}: ${incoming.length} message(s) written (${written.length} in total). ` +
          `Message classes need no activation.`,
        name,
        messages: written,
      });
    } catch (error: any) {
      if (lockHandle) { try { await this.adtclient.unLock(url, lockHandle); } catch (_) {} }
      const info = parseAdtError(error);
      const hint = info.isNotFound
        ? ` Create it first with abap_create(name="${name}", type="MSAG", ...).`
        : '';
      this.fail(formatError(`msag_set_messages(${name})`, error) + hint);
    }
  }

  // ─── wf_class_scaffold ──────────────────────────────────────────────────────

  private async handleScaffold(args: any): Promise<any> {
    let names;
    try {
      names = deriveWfNames(args);
    } catch (e: any) {
      this.fail(`wf_class_scaffold: ${e.message}`);
    }

    const sources = {
      [names.errorClass]: buildWfExceptionSource(names.errorClass, 'error', names),
      [names.tempClass]: buildWfExceptionSource(names.tempClass, 'temporary', names),
      [names.className]: buildWfClassSource(args, names),
    };
    const testSource = buildWfTestSource(names);
    const tableSource = buildClusterTableSource(names.clusterTable);
    const messages = wfDefaultMessages();

    if ((args.mode || 'preview') !== 'deploy') {
      return this.success({
        mode: 'preview',
        names,
        messages,
        sources: { ...sources, [`${names.className} (testclasses)`]: testSource, [names.clusterTable]: tableSource },
        next: 'Call again with mode="deploy", package and transport to create the objects in SAP.',
      });
    }

    if (!args.package) this.fail('wf_class_scaffold(deploy): package is required ($TMP allowed).');
    const pkg = String(args.package).toUpperCase();
    const isTmp = pkg === '$TMP';
    if (!isTmp && !args.transport) this.fail('wf_class_scaffold(deploy): transport REQUEST is required for non-$TMP packages.');
    const transport = args.transport ? String(args.transport).toUpperCase() : undefined;

    const objects = new ObjectHandlers(this.adtclient);
    const source = new SourceHandlers(this.adtclient);
    const tests = new TestHandlers(this.adtclient);
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    const run = async (step: string, fn: () => Promise<any>, optional = false): Promise<boolean> => {
      await this.notify(`wf_class_scaffold: ${step}…`);
      try {
        const r = await fn();
        const payload = parseToolPayload(r);
        if (payload?.activated === false || payload?.success === false) {
          throw new Error(JSON.stringify(payload.errors || payload.messages || payload));
        }
        steps.push({ step, ok: true, detail: payload?.message });
        return true;
      } catch (e: any) {
        steps.push({ step, ok: false, detail: e?.message || String(e) });
        if (!optional) throw new Error(`${step}: ${e?.message || e}`);
        return false;
      }
    };
    const exists = async (query: string, type: string): Promise<boolean> => {
      try {
        const r = await this.withSession(() => this.adtclient.searchObject(query, type)) as any[];
        return (r || []).some((o: any) => String(o['adtcore:name'] || '').toUpperCase() === query.toUpperCase());
      } catch (_) { return false; }
    };
    const create = (name: string, type: string, description: string) =>
      objects.validateAndHandle('abap_create', { name, type, description, package: pkg, transport });

    try {
      // 1. message class + messages
      if (!await exists(names.messageClass, 'MSAG')) {
        await run(`create message class ${names.messageClass}`, () => create(names.messageClass, 'MSAG', `Mensagens ${names.className}`));
      }
      await run(`write messages 000-003 in ${names.messageClass}`,
        () => this.handleSetMessages({ name: names.messageClass, messages, mode: 'merge', transport }), true);

      // 2. data cluster table (shared)
      if (!await exists(names.clusterTable, 'TABL')) {
        await run(`create table ${names.clusterTable}`, () => create(names.clusterTable, 'TABL', 'Workflow: data cluster XML (copia INDX)'));
        await run(`write table ${names.clusterTable}`,
          () => source.validateAndHandle('abap_set_source', { name: names.clusterTable, type: 'TABL', source: tableSource, transport }));
        await run(`activate table ${names.clusterTable}`,
          () => objects.validateAndHandle('abap_activate', { name: names.clusterTable, type: 'TABL' }));
      } else {
        steps.push({ step: `table ${names.clusterTable} already exists — reused`, ok: true });
      }

      // 3. exceptions + class
      for (const cls of [names.errorClass, names.tempClass, names.className]) {
        const desc = cls === names.className ? String(args.description).slice(0, 60)
          : cls === names.errorClass ? `${names.className}: erro definitivo` : `${names.className}: erro temporario`;
        await run(`create class ${cls}`, () => create(cls, 'CLAS', desc));
        await run(`write class ${cls}`,
          () => source.validateAndHandle('abap_set_source', { name: cls, type: 'CLAS', source: sources[cls], transport }));
      }
      await run('activate exceptions',
        () => objects.validateAndHandle('abap_activate_batch', {
          objects: [{ name: names.errorClass, type: 'CLAS' }, { name: names.tempClass, type: 'CLAS' }]
        }));
      await run(`activate ${names.className}`,
        () => objects.validateAndHandle('abap_activate', { name: names.className, type: 'CLAS' }));

      // 4. unit tests
      await run('create test include', () => tests.validateAndHandle('abap_create_test_include', { name: names.className, transport }));
      await run('write test include', () => source.validateAndHandle('abap_set_class_include',
        { name: names.className, include_type: 'testclasses', source: testSource, transport }));
      await run(`activate ${names.className} with tests`,
        () => objects.validateAndHandle('abap_activate', { name: names.className, type: 'CLAS' }));

      let unit: any;
      if (args.runTests !== false) {
        try {
          const r = await tests.validateAndHandle('abap_unit_test', { name: names.className });
          unit = parseToolPayload(r) || {};
          steps.push({ step: 'run ABAP Unit', ok: unit?.status === 'ALL PASSED', detail: unit?.status });
        } catch (e: any) {
          steps.push({ step: 'run ABAP Unit', ok: false, detail: e?.message });
        }
      }

      return this.success({
        mode: 'deploy',
        names,
        package: pkg,
        transport,
        steps,
        unitTests: unit?.summary,
        next: [
          `Mark ${names.keyField} as Key Attribute in SE24 if you want it shown (optional; the engine uses the LPOR).`,
          `Add business attributes/methods at the TODO markers, keeping parameters simple for binding.`,
          `Test events with SWELS/SWEL (category CL, type ${names.className}).`,
        ],
      });
    } catch (error: any) {
      this.fail(
        `wf_class_scaffold(deploy) stopped: ${error?.message || error}\n` +
        `Steps so far:\n${steps.map(s => `${s.ok ? 'OK ' : 'ERR'} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')}`
      );
    }
  }
}
