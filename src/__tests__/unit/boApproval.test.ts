import {
  deriveBoApprovalNames,
  buildApprovalTableSource,
  buildUpdateFmSource,
  buildRaiseEventFmSource,
  buildBorMethodsSource,
  buildGuiGuide,
  resolveDisplay,
  mainTableOf,
  type BoKeyField,
} from '../../lib/boApprovalTemplates';
import { BoApprovalHandlers, summarizePreflight, type PreflightRaw } from '../../handlers/BoApprovalHandlers';
import { ObjectHandlers } from '../../handlers/ObjectHandlers';
import { parseToolPayload } from '../../handlers/WorkflowHandlers';

const PO_KEY: BoKeyField[] = [{ verb: 'PURCHASEORDER', refStruct: 'EKKO', refField: 'EBELN', rollname: 'EBELN' }];
const INV_KEY: BoKeyField[] = [
  { verb: 'INVOICEDOCNUMBER', refStruct: 'RBKP', refField: 'BELNR', rollname: 'RE_BELNR' },
  { verb: 'FISCALYEAR', refStruct: 'RBKP', refField: 'GJAHR', rollname: 'GJAHR' },
];

describe('deriveBoApprovalNames', () => {
  it('derives defaults from the subtype within SAP length limits', () => {
    const n = deriveBoApprovalNames({ supertype: 'bus2012', subtype: 'zcust_po', event: 'pochanged' });
    expect(n).toMatchObject({
      supertype: 'BUS2012', subtype: 'ZCUST_PO', event: 'POCHANGED',
      table: 'ZCUST_PO_APR', functionGroup: 'ZCUST_PO_WF', updateFm: 'ZCUST_PO_UPD_STATUS',
      displayMethod: 'DISPLAYNEW', updateMethod: 'UPDATETABLE',
    });
    expect(n.table.length).toBeLessThanOrEqual(16);
    expect(n.wfAbbrev.length).toBeLessThanOrEqual(12);
    expect(n.tsDisplayAbbrev.length).toBeLessThanOrEqual(12);
    expect(n.tsUpdateAbbrev.length).toBeLessThanOrEqual(12);
  });

  it('defaults the event to ZCHANGED', () => {
    expect(deriveBoApprovalNames({ supertype: 'BUS2105', subtype: 'ZPR' }).event).toBe('ZCHANGED');
  });

  it('rejects bad names', () => {
    expect(() => deriveBoApprovalNames({ supertype: 'BUS2012', subtype: 'CUST_PO' })).toThrow(/Z or Y/);
    expect(() => deriveBoApprovalNames({ supertype: 'BUS2012', subtype: 'ZTOOLONGNAME' })).toThrow(/longer than 10/);
    expect(() => deriveBoApprovalNames({ supertype: 'BUS2012', subtype: 'ZPO', table: 'ZTHIS_IS_TOO_LONG_X' })).toThrow(/longer than 16/);
  });
});

describe('sources', () => {
  const n = deriveBoApprovalNames({ supertype: 'BUS2012', subtype: 'ZCUST_PO', event: 'POCHANGED' });

  it('builds the log table with the BO key between MANDT and the timestamp', () => {
    const src = buildApprovalTableSource(n, PO_KEY);
    expect(src).toContain('define table zcust_po_apr {');
    expect(src).toContain('@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE');
    expect(src).toMatch(/key mandt\s+: mandt not null;\n\s+key ebeln\s+: ebeln not null;\n\s+key ardate/);
    expect(src).toMatch(/status\s+: abap.char\(1\);/);
  });

  it('builds the update FM with MODIFY, existence check and no COMMIT', () => {
    const src = buildUpdateFmSource(n, PO_KEY);
    expect(src).toContain('FUNCTION zcust_po_upd_status');
    expect(src).toContain('VALUE(iv_ebeln) TYPE ebeln');
    expect(src).toContain('SELECT SINGLE @abap_true FROM ekko');
    expect(src).toContain('MODIFY zcust_po_apr FROM @ls_log.');
    expect(src).not.toMatch(/COMMIT WORK\./);
    expect(src).toContain('RAISING invalid_status');
  });

  it('handles composite keys in the table, FM and raise FM', () => {
    const inv = deriveBoApprovalNames({ supertype: 'BUS2081', subtype: 'ZINV' });
    expect(mainTableOf(INV_KEY)).toBe('RBKP');
    expect(buildApprovalTableSource(inv, INV_KEY)).toMatch(/key belnr\s+: re_belnr not null;\n\s+key gjahr/);
    expect(buildUpdateFmSource(inv, INV_KEY)).toContain('WHERE belnr = @iv_belnr\n      AND gjahr = @iv_gjahr');
    const raise = buildRaiseEventFmSource(inv, INV_KEY);
    expect(raise).toContain('BEGIN OF ls_key');
    expect(raise).toContain('lv_objkey = ls_key.');
  });

  it('builds the raise FM without commit', () => {
    const src = buildRaiseEventFmSource(n, PO_KEY);
    expect(src).toContain("object_type   = 'ZCUST_PO'");
    expect(src).toContain("event         = 'POCHANGED'");
    expect(src).toContain('commit_work   = space');
    expect(src).toContain('lv_objkey = iv_ebeln.');
  });

  it('uses the verified BUS2012 display preset in the BOR methods', () => {
    const spec = resolveDisplay({ supertype: 'BUS2012', subtype: 'ZCUST_PO' }, 'BUS2012');
    expect(spec.verified).toBe(true);
    const src = buildBorMethodsSource(n, PO_KEY, spec);
    expect(src).toContain("CALL FUNCTION 'ME_DISPLAY_PURCHASE_DOCUMENT'");
    expect(src).toContain('i_ebeln = object-key-purchaseorder');
    expect(src).toContain("swc_get_element container 'Status' lv_status.");
    expect(src).toContain("CALL FUNCTION 'ZCUST_PO_UPD_STATUS'");
    expect(src).toContain('exit_return 9001');
  });

  it('builds a transaction-based display with parameter IDs in key order', () => {
    const inv = deriveBoApprovalNames({ supertype: 'BUS2081', subtype: 'ZINV' });
    const spec = resolveDisplay({ supertype: 'BUS2081', subtype: 'ZINV' }, 'BUS2081');
    expect(spec.verified).toBe(false);
    const src = buildBorMethodsSource(inv, INV_KEY, spec);
    expect(src).toContain("SET PARAMETER ID 'RBN' FIELD object-key-invoicedocnumber.");
    expect(src).toContain("SET PARAMETER ID 'GJR' FIELD object-key-fiscalyear.");
    expect(src).toContain("CALL TRANSACTION 'MIR4' WITH AUTHORITY-CHECK AND SKIP FIRST SCREEN.");
  });

  it('falls back to a TODO display for unknown BOs', () => {
    expect(resolveDisplay({ supertype: 'ZFOO', subtype: 'ZBAR' }, 'ZFOO').kind).toBe('todo');
  });

  it('returns an ordered GUI guide', () => {
    const guide = buildGuiGuide(n, { cdObject: 'EINKBELEG', client: '500', keys: PO_KEY, display: resolveDisplay({} as any, 'BUS2012') });
    expect(guide.map(g => g.tcode)).toEqual(['SWO1', 'SWEC', 'SWDD', 'SWUE / SWI1 / SBWP']);
    expect(guide[1].actions[0]).toContain('EINKBELEG');
  });
});

describe('summarizePreflight', () => {
  const n = deriveBoApprovalNames({ supertype: 'BUS2012', subtype: 'ZCUST_PO' });
  const base: PreflightRaw = {
    supertypeExists: true, subtypeExists: false, keys: PO_KEY,
    cdFromSwec: ['EINKBELEG'], cdFromTcdob: ['EINKBELEG'],
    prefixes: [{ LEAD_NR: '900', SYSID: 'S4H', MANDT: '100' }],
    rfcDests: ['WORKFLOW_LOCAL_100'],
    existing: { table: false, functionGroup: false, updateFm: false, raiseFm: false },
  };

  it('picks the change document object and has no blockers', () => {
    const r = summarizePreflight(base, n, { client: '100' });
    expect(r.blockers).toEqual([]);
    expect(r.cdObject).toBe('EINKBELEG');
    expect(r.warnings).toEqual([]);
  });

  it('warns about missing prefix number and SWU3 destination for the GUI client', () => {
    const r = summarizePreflight(base, n, { client: '500' });
    expect(r.warnings.join('\n')).toMatch(/prefix number.*500/);
    expect(r.warnings.join('\n')).toMatch(/WORKFLOW_LOCAL_500/);
  });

  it('blocks when the supertype is unknown or has no key', () => {
    expect(summarizePreflight({ ...base, supertypeExists: false }, n, {}).blockers[0]).toMatch(/not found/);
    expect(summarizePreflight({ ...base, keys: [] }, n, {}).blockers[0]).toMatch(/no key fields/);
  });
});

describe('wf_bo_approval_scaffold handler', () => {
  function handlerWith(raw: PreflightRaw) {
    const h = new BoApprovalHandlers({} as any);
    jest.spyOn(h as any, 'collectPreflight').mockResolvedValue(raw);
    return h;
  }
  const raw: PreflightRaw = {
    supertypeExists: true, subtypeExists: false, keys: PO_KEY,
    cdFromSwec: ['EINKBELEG'], cdFromTcdob: [], prefixes: [], rfcDests: [],
    existing: { table: false, functionGroup: false, updateFm: false, raiseFm: false },
  };

  it('preview returns sources, BOR code and guide', async () => {
    const r = parseToolPayload(await handlerWith(raw).validateAndHandle('wf_bo_approval_scaffold',
      { supertype: 'BUS2012', subtype: 'ZCUST_PO', event: 'POCHANGED', client: '500', includeRaiseFm: true }));
    expect(r.mode).toBe('preview');
    expect(Object.keys(r.sources)).toEqual(['ZCUST_PO_APR', 'ZCUST_PO_UPD_STATUS', 'ZCUST_PO_RAISE_EVT']);
    expect(r.borMethodsSource).toContain('BEGIN_METHOD DISPLAYNEW');
    expect(r.guide).toHaveLength(4);
  });

  it('check mode returns only the pre-flight', async () => {
    const r = parseToolPayload(await handlerWith(raw).validateAndHandle('wf_bo_approval_scaffold',
      { supertype: 'BUS2012', subtype: 'ZCUST_PO', mode: 'check' }));
    expect(r.mode).toBe('check');
    expect(r.sources).toBeUndefined();
  });

  it('stops on blockers', async () => {
    const r = parseToolPayload(await handlerWith({ ...raw, supertypeExists: false }).validateAndHandle('wf_bo_approval_scaffold',
      { supertype: 'BUS9999', subtype: 'ZX', mode: 'deploy', package: '$TMP' }));
    expect(r.mode).toMatch(/stopped by blockers/);
  });

  it('deploy requires package, and transport outside $TMP', async () => {
    await expect(handlerWith(raw).validateAndHandle('wf_bo_approval_scaffold',
      { supertype: 'BUS2012', subtype: 'ZCUST_PO', mode: 'deploy' })).rejects.toThrow(/package is required/);
    await expect(handlerWith(raw).validateAndHandle('wf_bo_approval_scaffold',
      { supertype: 'BUS2012', subtype: 'ZCUST_PO', mode: 'deploy', package: 'ZPKG' })).rejects.toThrow(/transport is required/);
  });
});

describe('abap_activate FUGR/FF', () => {
  it('activates the function group and the FM together', async () => {
    const activate = jest.fn(async () => ({ success: true, messages: [], inactive: [] }));
    const h = new ObjectHandlers({ activate } as any);
    await h.validateAndHandle('abap_activate', { name: 'ZCUST_PO_UPD_STATUS', type: 'FUGR/FF', fugr: 'ZCUST_PO_WF' });
    const [refs, preaudit] = (activate.mock.calls[0] as any[]);
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.map((r: any) => r['adtcore:type'])).toEqual(['FUGR/F', 'FUGR/FF']);
    expect(refs[1]['adtcore:uri']).toBe('/sap/bc/adt/functions/groups/zcust_po_wf/fmodules/zcust_po_upd_status');
    expect(preaudit).toBe(true);
  });
});
