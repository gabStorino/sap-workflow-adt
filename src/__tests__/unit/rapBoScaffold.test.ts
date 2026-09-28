import {
  deriveRapBoNames,
  camelAlias,
  relevantFields,
  buildInterfaceViewSource,
  buildProjectionViewSource,
  buildBehaviorDefRootSource,
  buildBehaviorDefProjectionSource,
  buildBehaviorPoolClassSource,
  buildDraftTableSource,
  buildServiceDefinitionSource,
  buildGuiGuide,
  type RapTableField,
} from '../../lib/rapBoTemplates';

const FIELDS: RapTableField[] = [
  { fieldName: 'MANDT', isKey: true, rollname: 'MANDT' },
  { fieldName: 'ORDER_ID', isKey: true, rollname: undefined, intType: 'C', length: 10 },
  { fieldName: 'CUSTOMER_NAME', isKey: false, intType: 'C', length: 40 },
  { fieldName: 'CREATED_AT', isKey: false, rollname: 'TIMESTAMPL' },
];

describe('deriveRapBoNames', () => {
  it('derives defaults from the table name within SAP length limits', () => {
    const n = deriveRapBoNames({ table: 'zcustorder' });
    expect(n).toMatchObject({
      table: 'ZCUSTORDER',
      base: 'CUSTORDER',
      interfaceView: 'ZI_CUSTORDER',
      projectionView: 'ZC_CUSTORDER',
      behaviorPoolClass: 'ZBP_CUSTORDER',
      serviceDefinition: 'ZSD_CUSTORDER',
      serviceBinding: 'ZUI_CUSTORDER_O4',
      serviceVersion: 'V4',
      draft: false,
    });
    expect(n.draftTable).toBeUndefined();
  });

  it('honors an explicit base name distinct from the table', () => {
    const n = deriveRapBoNames({ table: 'ZCO_ORD_DB', name: 'CustOrder' });
    expect(n.interfaceView).toBe('ZI_CUSTORDER');
    expect(n.base).toBe('CUSTORDER');
  });

  it('derives a draft table name when draft=true', () => {
    const n = deriveRapBoNames({ table: 'ZCUSTORDER', draft: true });
    expect(n.draft).toBe(true);
    expect(n.draftTable).toBe('ZCUSTORDERD');
    expect(n.draftTable!.length).toBeLessThanOrEqual(16);
  });

  it('supports V2 naming', () => {
    const n = deriveRapBoNames({ table: 'ZCUSTORDER', serviceVersion: 'V2' });
    expect(n.serviceBinding).toBe('ZUI_CUSTORDER_O2');
  });

  it('rejects an invalid table name', () => {
    expect(() => deriveRapBoNames({ table: '' })).toThrow(/must be a DDIC table name/);
  });

  it('rejects an override that is too long', () => {
    expect(() => deriveRapBoNames({ table: 'ZCUSTORDER', interfaceView: 'ZI_WAY_TOO_LONG_FOR_A_CDS_VIEW_ENTITY_NAME' })).toThrow(/longer than 30/);
  });

  it('rejects a draft table equal to the source table', () => {
    expect(() => deriveRapBoNames({ table: 'ZCUSTORDER', draft: true, draftTable: 'ZCUSTORDER' })).toThrow(/must differ/);
  });
});

describe('camelAlias', () => {
  it('beautifies snake_case and plain DDIC field names', () => {
    expect(camelAlias('EBELN')).toBe('Ebeln');
    expect(camelAlias('ORDER_ID')).toBe('OrderId');
    expect(camelAlias('CREATED_AT')).toBe('CreatedAt');
  });
});

describe('relevantFields', () => {
  it('drops MANDT and technical include markers', () => {
    const rel = relevantFields(FIELDS);
    expect(rel.map(f => f.fieldName)).toEqual(['ORDER_ID', 'CUSTOMER_NAME', 'CREATED_AT']);
  });
});

const CURR_FIELDS: RapTableField[] = [
  { fieldName: 'MANDT', isKey: true, rollname: 'MANDT' },
  { fieldName: 'ORDER_ID', isKey: true, intType: 'C', length: 10 },
  { fieldName: 'PRICE', isKey: false, dataType: 'CURR', refField: 'CURRENCY', length: 15, decimals: 2 },
  { fieldName: 'CURRENCY', isKey: false, dataType: 'CUKY', length: 5 },
  { fieldName: 'QUANTITY', isKey: false, dataType: 'QUAN', refField: 'UNIT', length: 13, decimals: 3 },
  { fieldName: 'UNIT', isKey: false, dataType: 'UNIT', length: 3 },
];

describe('currency/quantity semantic annotations', () => {
  const n = deriveRapBoNames({ table: 'ZCUSTORDER' });

  it('annotates a CURR field with @Semantics.amount.currencyCode pointing at its ref field', () => {
    const src = buildInterfaceViewSource(n, CURR_FIELDS);
    expect(src).toMatch(/@Semantics\.amount\.currencyCode: 'Currency'\s*\n\s*price\s+as Price,/);
  });

  it('annotates a QUAN field with @Semantics.quantity.unitOfMeasure pointing at its ref field', () => {
    const src = buildInterfaceViewSource(n, CURR_FIELDS);
    expect(src).toMatch(/@Semantics\.quantity\.unitOfMeasure: 'Unit'\s*\n\s*quantity\s+as Quantity,/);
  });

  it('never annotates the currency/unit field itself — @Semantics.currencyCode/.unitOfMeasure ' +
     'are classic-CDS-view syntax and SAP rejects them on a view entity ("not allowed in view entities")', () => {
    const src = buildInterfaceViewSource(n, CURR_FIELDS);
    expect(src).not.toContain('@Semantics.currencyCode');
    expect(src).not.toContain('@Semantics.unitOfMeasure');
  });

  it('skips the annotation when the ref field is not exposed (e.g. filtered out upstream)', () => {
    const noCurrencyField = CURR_FIELDS.filter(f => f.fieldName !== 'CURRENCY');
    const src = buildInterfaceViewSource(n, noCurrencyField);
    expect(src).not.toContain('@Semantics.amount.currencyCode');
  });

  it('does not annotate plain fields with no dataType (backward compatible)', () => {
    const src = buildInterfaceViewSource(n, FIELDS);
    expect(src).not.toContain('@Semantics.');
  });
});

describe('sources', () => {
  const n = deriveRapBoNames({ table: 'ZCUSTORDER' });
  const nDraft = deriveRapBoNames({ table: 'ZCUSTORDER', draft: true });

  it('builds the interface view with key/non-key fields beautified', () => {
    const src = buildInterfaceViewSource(n, FIELDS);
    expect(src).toContain('define root view entity ZI_CUSTORDER');
    expect(src).toContain('as select from zcustorder');
    expect(src).toMatch(/key order_id\s+as OrderId,/);
    expect(src).toContain('customer_name as CustomerName,');
    expect(src).not.toMatch(/mandt/i);
  });

  it('rejects a table with no key fields', () => {
    const noKeys: RapTableField[] = [{ fieldName: 'FOO', isKey: false }];
    expect(() => buildInterfaceViewSource(n, noKeys)).toThrow(/needs at least one key/);
  });

  it('builds the projection view delegating to the interface view', () => {
    const src = buildProjectionViewSource(n, FIELDS);
    expect(src).toContain('as projection on ZI_CUSTORDER');
    expect(src).toContain('key OrderId,');
    expect(src).toContain('@UI.lineItem');
  });

  it('builds the root behavior definition without draft clauses', () => {
    const src = buildBehaviorDefRootSource(n, FIELDS);
    expect(src).toContain('managed implementation in class zbp_custorder unique;');
    expect(src).toContain('define behavior for ZI_CUSTORDER alias CUSTORDER');
    expect(src).not.toContain('draft table');
    expect(src).toMatch(/OrderId\s+= order_id;/);
  });

  it('does not declare authorization master (the generated behavior pool has no handler for it)', () => {
    expect(buildBehaviorDefRootSource(n, FIELDS)).not.toContain('authorization master');
    expect(buildBehaviorDefRootSource(nDraft, FIELDS)).not.toContain('authorization master');
  });

  it('guide explains the missing authorization master', () => {
    expect(buildGuiGuide(n).some(s => s.includes('authorization master'))).toBe(true);
  });

  it('builds the root behavior definition with draft clauses when requested', () => {
    const src = buildBehaviorDefRootSource(nDraft, FIELDS);
    expect(src).toContain(`draft table ${nDraft.draftTable!.toLowerCase()}`);
    expect(src).toContain('draft action Edit;');
    expect(src).toContain('draft determine action Prepare;');
  });

  it('builds the projection behavior definition delegating with use', () => {
    const src = buildBehaviorDefProjectionSource(n);
    expect(src).toContain('projection;');
    expect(src).toContain('define behavior for ZC_CUSTORDER alias CUSTORDER');
    expect(src).toContain('use create;');
    expect(src).not.toContain('use action Edit;');
  });

  it('adds draft actions to the projection behavior definition when draft=true', () => {
    const src = buildBehaviorDefProjectionSource(nDraft);
    expect(src).toContain('use action Edit;');
    expect(src).toContain('use action Activate;');
  });

  it('builds an empty behavior pool class stub', () => {
    const src = buildBehaviorPoolClassSource(n);
    expect(src).toContain('CLASS zbp_custorder DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zi_custorder.');
    expect(src).toContain('CLASS zbp_custorder IMPLEMENTATION.');
  });

  it('builds a draft table with admin fields plus business keys', () => {
    const src = buildDraftTableSource(nDraft, FIELDS);
    expect(src).toContain(`define table ${nDraft.draftTable!.toLowerCase()} {`);
    expect(src).toMatch(/key order_id\s+: abap.char\(10\) not null;/);
    expect(src).toContain('draftuuid');
    expect(src).toContain('draftisdraft');
  });

  it('builds the service definition exposing the projection view', () => {
    const src = buildServiceDefinitionSource(n);
    expect(src).toContain('define service ZSD_CUSTORDER');
    expect(src).toContain('expose ZC_CUSTORDER as CUSTORDER;');
  });

  it('guide flags the service binding as a manual step and mentions rap_publish_binding', () => {
    const guide = buildGuiGuide(n);
    expect(guide.some(s => s.includes('rap_publish_binding'))).toBe(true);
    expect(guide.some(s => s.includes(n.serviceBinding))).toBe(true);
  });

  it('guide adds a draft-table verification caveat when draft=true', () => {
    const guide = buildGuiGuide(nDraft);
    expect(guide.some(s => s.includes('not verified end to end'))).toBe(true);
  });
});
