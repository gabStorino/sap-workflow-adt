/**
 * Generators for the "full RAP Business Object scaffold" recipe (rap_bo_scaffold).
 *
 * Scenario (managed RAP BO, S/4HANA / BTP ABAP Environment, starting from an existing
 * DDIC table):
 *   DB table
 *     -> CDS interface (root) view entity  -- select from the table, field beautification
 *        -> behavior definition (root)     -- managed implementation, optional draft
 *           -> behavior pool class          -- empty stub (pure managed: no handler methods)
 *        -> CDS projection (consumption) view entity -- "as projection on" the interface view
 *           -> behavior definition (projection) -- "projection;" delegating to the root
 *              -> service definition -- exposes the projection view
 *                 -> service binding  -- NOT created here, see buildGuiGuide()
 *
 * Pure functions only (no SAP access) so everything can be unit-tested and previewed,
 * mirroring the boApprovalTemplates.ts / wfTemplates.ts pattern used by the other
 * *_scaffold tools in this project.
 *
 * Honesty note (same spirit as wf_bo_approval_scaffold): the service binding (SRVB) is
 * NOT auto-created by mode=deploy. Its ADT creation payload needs binding-type/category
 * metadata this project has not exercised against a real system yet (the underlying
 * abap-adt-api createObject() binding options only cover OData V2, and getting the OData
 * V4 XML wrong on a real system risks a half-created object that needs manual SE80/ADT
 * cleanup). Creating the SRVB is returned as a guide step instead; once it exists, use
 * the already-verified rap_publish_binding tool to publish it. The generated draft table
 * (when draft=true) is a best-effort starting point too — verify its technical fields
 * against your NW release before deploying (SAP's own draft-table shape has changed
 * across releases).
 */

export interface RapTableField {
  /** DD03L-FIELDNAME, e.g. EBELN */
  fieldName: string;
  /** DD03L-KEYFLAG === 'X' */
  isKey: boolean;
  /** DD03L-ROLLNAME (data element), when set */
  rollname?: string;
  /** DD03L-INTTYPE (C, N, D, P, ...) — used when rollname is empty */
  intType?: string;
  /** DD03L-LENG */
  length?: number;
  /** DD03L-DECIMALS */
  decimals?: number;
  /** DD03L-DATATYPE (CURR, QUAN, CUKY, UNIT, CHAR, ...) */
  dataType?: string;
  /** DD03L-REFFIELD — for CURR/QUAN fields, the sibling field (same table) holding the
   *  currency/unit of measure. Missing this on the CDS view is what makes SAP throw
   *  CX_SADL_DUMP_APPL_MODEL_ERROR at runtime once a UI (e.g. Fiori Elements) actually
   *  queries the data — found live scaffolding SFLIGHT (PRICE/PAYMENTSUM are CURR
   *  referencing CURRENCY). CDS activation itself does not catch this. */
  refField?: string;
}

export type ServiceVersion = 'V4' | 'V2';

export interface RapBoInput {
  table: string;
  name?: string;
  description?: string;
  draft?: boolean;
  serviceVersion?: ServiceVersion;
  interfaceView?: string;
  projectionView?: string;
  behaviorPoolClass?: string;
  serviceDefinition?: string;
  serviceBinding?: string;
  draftTable?: string;
}

export interface RapBoNames {
  table: string;
  base: string;
  description: string;
  draft: boolean;
  serviceVersion: ServiceVersion;
  interfaceView: string;
  projectionView: string;
  behaviorPoolClass: string;
  serviceDefinition: string;
  serviceBinding: string;
  draftTable?: string;
}

const Z_NAME = /^[ZY][A-Z0-9_]*$/;
const TABLE_NAME = /^[A-Z0-9_/]+$/;

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).replace(/_+$/, '') : s;
}

function checkZ(label: string, value: string, max: number): string {
  const v = value.toUpperCase().trim();
  if (!Z_NAME.test(v)) throw new Error(`${label} "${value}" must start with Z or Y and contain only A-Z, 0-9 and _`);
  if (v.length > max) throw new Error(`${label} "${v}" is longer than ${max} characters`);
  return v;
}

/** Derive every artifact name from the source table (and optional overrides), applying SAP length limits. */
export function deriveRapBoNames(input: RapBoInput): RapBoNames {
  const table = String(input.table || '').toUpperCase().trim();
  if (!table || !TABLE_NAME.test(table)) {
    throw new Error(`table "${input.table}" must be a DDIC table name, e.g. ZCUSTORDER`);
  }

  // ZCUSTORDER -> CUSTORDER (strip a leading Z/Y so composed names like ZI_/ZC_/ZBP_ don't double up)
  const rawBase = String(input.name || table).toUpperCase().trim().replace(/^[ZY]/, '').replace(/^_+/, '');
  const base = rawBase.replace(/[^A-Z0-9_]/g, '');
  if (!base) throw new Error(`Could not derive a base name from table "${table}" — pass "name" explicitly.`);

  const draft = input.draft === true || (input.draft as any) === 'true';
  const serviceVersion: ServiceVersion = input.serviceVersion === 'V2' ? 'V2' : 'V4';
  const svcSuffix = serviceVersion === 'V4' ? '_O4' : '_O2';

  const names: RapBoNames = {
    table,
    base,
    description: input.description || `RAP BO for ${table}`,
    draft,
    serviceVersion,
    interfaceView: checkZ('interfaceView', input.interfaceView || `ZI_${cut(base, 28)}`, 30),
    projectionView: checkZ('projectionView', input.projectionView || `ZC_${cut(base, 28)}`, 30),
    behaviorPoolClass: checkZ('behaviorPoolClass', input.behaviorPoolClass || `ZBP_${cut(base, 26)}`, 30),
    serviceDefinition: checkZ('serviceDefinition', input.serviceDefinition || `ZSD_${cut(base, 26)}`, 30),
    serviceBinding: checkZ('serviceBinding', input.serviceBinding || `ZUI_${cut(base, 26 - svcSuffix.length)}${svcSuffix}`, 30),
  };
  if (draft) {
    names.draftTable = checkZ('draftTable', input.draftTable || `${cut(table, 14)}D`, 16);
    if (names.draftTable === table) throw new Error('draftTable must differ from table — pass an explicit override.');
  }
  return names;
}

// ─── field helpers ──────────────────────────────────────────────────────────

/** DB_FIELD_NAME -> UpperCamelCase alias used as the CDS field name. */
export function camelAlias(fieldName: string): string {
  return fieldName
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || fieldName;
}

/** Fields relevant to CDS generation: drop MANDT (client is implicit) and technical include markers. */
export function relevantFields(fields: RapTableField[]): RapTableField[] {
  return fields.filter(f => f.fieldName && f.fieldName.toUpperCase() !== 'MANDT' && !f.fieldName.startsWith('.'));
}

function assertFields(fields: RapTableField[]): void {
  if (!fields || fields.length === 0) throw new Error('no usable fields found for this table (DD03L returned nothing) — check the table name');
  if (!fields.some(f => f.isKey)) throw new Error('the table has no key fields besides MANDT — a CDS root view entity needs at least one key');
}

// ─── CDS interface (root) view entity ──────────────────────────────────────

// CURR fields need @Semantics.amount.currencyCode and QUAN fields need
// @Semantics.quantity.unitOfMeasure pointing at their sibling currency/unit field, or SAP
// throws CX_SADL_DUMP_APPL_MODEL_ERROR at runtime the first time a UI actually queries the
// data (CDS activation does not catch it — found live scaffolding SFLIGHT: PRICE/PAYMENTSUM
// are CURR referencing CURRENCY, which had no annotation and activated "successfully" right
// up until Fiori Elements tried to render a row). Only the amount/quantity field gets
// annotated: marking the currency/unit field itself with @Semantics.currencyCode /
// @Semantics.unitOfMeasure is classic-CDS-view syntax and is REJECTED on a CDS view entity
// ("Annotation Semantics.currencyCode is not allowed in view entities") — found live on the
// very next deploy attempt after adding it. Silently skipped if the reference field isn't
// exposed in the generated view.
function semanticAnnotationsFor(f: RapTableField, rel: RapTableField[]): string[] {
  const dt = (f.dataType || '').toUpperCase();
  if (dt !== 'CURR' && dt !== 'QUAN') return [];
  const refField = f.refField;
  if (!refField) return [];
  const refExposed = rel.some(r => r.fieldName.toUpperCase() === refField.toUpperCase());
  if (!refExposed) return [];
  const refAlias = camelAlias(refField);
  return dt === 'CURR'
    ? [`@Semantics.amount.currencyCode: '${refAlias}'`]
    : [`@Semantics.quantity.unitOfMeasure: '${refAlias}'`];
}

export function buildInterfaceViewSource(names: RapBoNames, fields: RapTableField[]): string {
  const rel = relevantFields(fields);
  assertFields(rel);
  const width = Math.max(...rel.map(f => f.fieldName.toLowerCase().length));
  const pad = (s: string) => s.padEnd(width);
  const lines = rel.flatMap(f => {
    const annotations = semanticAnnotationsFor(f, rel).map(a => `      ${a}`);
    return [
      ...annotations,
      `      ${f.isKey ? 'key ' : '    '}${pad(f.fieldName.toLowerCase())} as ${camelAlias(f.fieldName)},`,
    ];
  });
  // drop trailing comma on the last field
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');

  return [
    `@AccessControl.authorizationCheck: #CHECK`,
    `@EndUserText.label: '${names.description}'`,
    `@Metadata.allowExtensions: true`,
    `@ObjectModel.usageType:{`,
    `  serviceQuality: #X,`,
    `  sizeCategory: #S,`,
    `  dataClass: #MIXED`,
    `}`,
    `define root view entity ${names.interfaceView}`,
    `  as select from ${names.table.toLowerCase()}`,
    `{`,
    ...lines,
    `}`,
  ].join('\n') + '\n';
}

// ─── CDS projection (consumption) view entity ──────────────────────────────

export function buildProjectionViewSource(names: RapBoNames, fields: RapTableField[]): string {
  const rel = relevantFields(fields);
  assertFields(rel);
  const keyLines = rel.filter(f => f.isKey).map(f => `      key ${camelAlias(f.fieldName)},`);
  const nonKey = rel.filter(f => !f.isKey);
  const nonKeyLines = nonKey.flatMap((f, i) => [
    `      @UI.lineItem: [{ position: ${(i + 1) * 10} }]`,
    `      @UI.identification: [{ position: ${(i + 1) * 10} }]`,
    `      ${camelAlias(f.fieldName)},`,
  ]);
  // drop trailing comma on the very last emitted field line
  const allLines = [...keyLines, ...nonKeyLines];
  const lastFieldIdx = allLines.map(l => l.trim().startsWith('@') ? null : l).reduce((acc, l, i) => l !== null ? i : acc, -1);
  if (lastFieldIdx >= 0) allLines[lastFieldIdx] = allLines[lastFieldIdx].replace(/,$/, '');

  return [
    `@EndUserText.label: '${names.description}'`,
    `@Metadata.allowExtensions: true`,
    `@UI.headerInfo.typeName: '${names.base}'`,
    `@UI.headerInfo.typeNamePlural: '${names.base}s'`,
    `@Search.searchable: true`,
    `define root view entity ${names.projectionView}`,
    `  as projection on ${names.interfaceView}`,
    `{`,
    ...allLines,
    `}`,
  ].join('\n') + '\n';
}

// ─── behavior definition (root) ─────────────────────────────────────────────

export function buildBehaviorDefRootSource(names: RapBoNames, fields: RapTableField[]): string {
  const rel = relevantFields(fields);
  assertFields(rel);
  const width = Math.max(...rel.map(f => camelAlias(f.fieldName).length));
  const pad = (s: string) => s.padEnd(width);
  const mappingLines = rel.map(f => `    ${pad(camelAlias(f.fieldName))} = ${f.fieldName.toLowerCase()};`);

  const draftClauses = names.draft
    ? [
      `draft table ${names.draftTable!.toLowerCase()}`,
    ]
    : [];
  const draftActions = names.draft
    ? [
      ``,
      `  draft action Edit;`,
      `  draft action Activate;`,
      `  draft action Discard;`,
      `  draft action Resume;`,
      `  draft determine action Prepare;`,
    ]
    : [];

  return [
    `managed implementation in class ${names.behaviorPoolClass.toLowerCase()} unique;`,
    ``,
    `define behavior for ${names.interfaceView} alias ${names.base}`,
    `persistent table ${names.table.toLowerCase()}`,
    ...draftClauses,
    `lock master`,
    // No "authorization master ( instance )": it obliges a get_instance_authorizations handler
    // in a local handler class, and this tool generates an EMPTY behavior pool. Activation does
    // not catch the gap; the first Fiori Elements read does (it asks for update/delete
    // availability per row) -> CX_RAP_HANDLER_NOT_IMPLEMENTED (method AUTHORITY_CHECK), wrapped
    // as CX_SADL_DUMP_APPL_MODEL_ERROR. Found live on SFLIGHT. The guide tells the user to add
    // it back together with the handler once they write real authorization logic.
    `{`,
    `  create;`,
    `  update;`,
    `  delete;`,
    ...draftActions,
    ``,
    `  mapping for ${names.table.toLowerCase()}`,
    `  {`,
    ...mappingLines,
    `  }`,
    `}`,
  ].join('\n') + '\n';
}

// ─── behavior definition (projection) ──────────────────────────────────────

export function buildBehaviorDefProjectionSource(names: RapBoNames): string {
  const draftActions = names.draft
    ? [
      `  use action Edit;`,
      `  use action Activate;`,
      `  use action Discard;`,
      `  use action Resume;`,
    ]
    : [];
  return [
    `projection;`,
    ``,
    `define behavior for ${names.projectionView} alias ${names.base}`,
    `{`,
    `  use create;`,
    `  use update;`,
    `  use delete;`,
    ...draftActions,
    `}`,
  ].join('\n') + '\n';
}

// ─── behavior pool class (empty stub — pure managed scenario) ─────────────

export function buildBehaviorPoolClassSource(names: RapBoNames): string {
  const cls = names.behaviorPoolClass.toLowerCase();
  return [
    `CLASS ${cls} DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF ${names.interfaceView.toLowerCase()}.`,
    `ENDCLASS.`,
    ``,
    `CLASS ${cls} IMPLEMENTATION.`,
    `ENDCLASS.`,
  ].join('\n') + '\n';
}

// ─── draft table (best-effort — see module doc) ────────────────────────────

export function buildDraftTableSource(names: RapBoNames, fields: RapTableField[]): string {
  if (!names.draftTable) throw new Error('draftTable name not set — call with draft=true');
  const rel = relevantFields(fields);
  assertFields(rel);
  const width = Math.max(6, ...rel.map(f => f.fieldName.toLowerCase().length));
  const pad = (s: string) => s.padEnd(width);
  const keyLines = rel.filter(f => f.isKey).map(f => `  key ${pad(f.fieldName.toLowerCase())} : ${ddlType(f)} not null;`);
  const nonKeyLines = rel.filter(f => !f.isKey).map(f => `      ${pad(f.fieldName.toLowerCase())} : ${ddlType(f)};`);

  return [
    `@EndUserText.label : 'Draft table for ${names.interfaceView}'`,
    `@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE`,
    `@AbapCatalog.tableCategory : #TRANSPARENT`,
    `@AbapCatalog.deliveryClass : #A`,
    `@AbapCatalog.dataMaintenance : #RESTRICTED`,
    `define table ${names.draftTable.toLowerCase()} {`,
    `  key ${pad('mandt')} : mandt not null;`,
    ...keyLines,
    `      ${pad('draftuuid')} : sysuuid_x16;`,
    `      ${pad('draftisdraft')} : abap.char(1);`,
    `      ${pad('draftlastchangedat')} : timestampl;`,
    ...nonKeyLines,
    `}`,
  ].join('\n') + '\n';
}

function ddlType(f: RapTableField): string {
  if (f.rollname) return f.rollname.toLowerCase();
  const len = f.length || 10;
  switch ((f.intType || 'C').toUpperCase()) {
    case 'N': return `abap.numc(${len})`;
    case 'D': return 'abap.dats';
    case 'T': return 'abap.tims';
    case 'P': return `abap.dec(${len},${f.decimals || 0})`;
    default: return `abap.char(${len})`;
  }
}

// ─── service definition ────────────────────────────────────────────────────

export function buildServiceDefinitionSource(names: RapBoNames): string {
  return [
    `@EndUserText.label: '${names.description}'`,
    `define service ${names.serviceDefinition}`,
    `{`,
    `  expose ${names.projectionView} as ${names.base};`,
    `}`,
  ].join('\n') + '\n';
}

// ─── SAP GUI / manual-step guide ────────────────────────────────────────────

export function buildGuiGuide(names: RapBoNames): string[] {
  const steps = [
    `1. Review the field aliases (beautification) in ${names.interfaceView} and adjust names/annotations to taste.`,
    `2. Add UI annotations (@UI.selectionField, @UI.facet, value helps, etc.) to ${names.projectionView} as needed — ` +
    `the generated one only has a minimal @UI.lineItem/@UI.identification per field, enough for a plain Fiori Elements list-report.`,
    `3. Service binding (SRVB) is NOT auto-created (see tool notes on why). In ADT/Eclipse or SAP GUI: right-click ` +
    `${names.serviceDefinition} -> New Service Binding -> name "${names.serviceBinding}", binding type "OData ${names.serviceVersion} - UI". ` +
    `Then call rap_publish_binding(name="${names.serviceBinding}", version="0001", action="publish") to publish it, and ` +
    `rap_binding_details(name="${names.serviceBinding}") to get the service URL.`,
    `4. Once published, preview via the service URL or generate a Fiori Elements app (App Generator / SEGW-equivalent wizard) pointed at ${names.serviceBinding}.`,
    `5. No "strict" declaration was generated in the behavior definitions — its exact syntax (plain "strict;" vs "strict(N);") varies enough ` +
    `across releases that guessing it risked a broken deploy. If your release supports it, add it back yourself (in ADT, under ` +
    `${names.interfaceView}'s and ${names.projectionView}'s behavior definitions) for the extra compile-time checks it gives you.`,
    `6. ${names.projectionView} was generated without a "provider contract" clause (e.g. "transactional_query") after the same clause failed ` +
    `to activate on a real system with "Unexpected word \\"provider\\"". If your release supports it, add the appropriate provider contract ` +
    `back to ${names.projectionView} yourself — it is standard for a RAP consumption view on current releases.`,
    `7. No "authorization master ( instance )" was generated: it requires a get_instance_authorizations handler in ${names.behaviorPoolClass}, ` +
    `which is generated empty. Without the handler the first read from a UI dumps (CX_RAP_HANDLER_NOT_IMPLEMENTED, AUTHORITY_CHECK). ` +
    `When you add authorization checks, add the clause to ${names.interfaceView}'s behavior definition AND implement the handler in the class's local types.`,
  ];
  if (names.draft) {
    steps.push(
      `8. Draft handling requested: the generated ${names.draftTable} table is a best-effort starting point (MANDT + business keys + ` +
      `DRAFTUUID/DRAFTISDRAFT/DRAFTLASTCHANGEDAT). Compare it against a system-generated draft table (Data Modeler "Generate Draft Table" ` +
      `on ${names.interfaceView}, or an existing draft-enabled CDS view on the same release) before deploying — the exact technical draft ` +
      `admin fields SAP expects have changed across NW/S4 releases, and this preset is not verified end to end.`
    );
  }
  return steps;
}
