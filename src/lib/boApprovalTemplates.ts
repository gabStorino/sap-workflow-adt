/**
 * Generators for the "BO subtype approval workflow" recipe (wf_bo_approval_scaffold).
 *
 * Scenario (classic BOR workflow, tested end to end on S/4HANA with BUS2012):
 *   document changed and saved
 *     -> change document (SWEC) raises Z<BO>.<EVENT>
 *       -> WS template started by the event
 *          -> dialog activity: display document (BOR method DISPLAYNEW) -> initiator
 *          -> user decision Approve / Reject
 *             -> container operation STATUS = 'A' | 'R'
 *          -> (join) background activity UPDATETABLE -> FM -> Z table
 *
 * Pure functions only (no SAP access) so everything can be unit-tested and previewed.
 * Objects that ADT cannot create (BOR subtype in SWO1, TS/WS in PFTC/SWDD, SWEC entry,
 * prefix number, SWU3) are returned as a step-by-step SAP GUI guide.
 */

export interface BoKeyField {
  /** BOR key field (SWOTDV-VERB), e.g. PURCHASEORDER */
  verb: string;
  /** DDIC reference table (SWOTDV-REFSTRUCT), e.g. EKKO */
  refStruct: string;
  /** DDIC reference field (SWOTDV-REFFIELD), e.g. EBELN */
  refField: string;
  /** Data element of refStruct-refField (DD03L-ROLLNAME); empty when the field has a built-in type */
  rollname?: string;
  /** DD03L-INTTYPE (C, N, D, ...) — used when rollname is empty */
  intType?: string;
  /** DD03L-LENG */
  length?: number;
}

export interface BoDisplaySpec {
  kind: 'fm' | 'tcode' | 'todo';
  /** kind=fm: complete CALL FUNCTION block with {key:VERB} placeholders */
  fmCall?: string;
  /** kind=tcode */
  tcode?: string;
  /** kind=tcode: SET PARAMETER IDs in key-field order */
  paramIds?: string[];
  /** true only for presets verified end to end in a real system */
  verified: boolean;
  note?: string;
}

export interface BoApprovalInput {
  supertype: string;
  subtype: string;
  description?: string;
  event?: string;
  table?: string;
  functionGroup?: string;
  updateFm?: string;
  raiseFm?: string;
  wfAbbrev?: string;
  tsDisplayAbbrev?: string;
  tsUpdateAbbrev?: string;
  displayFm?: string;
  displayTcode?: string;
  displayParamIds?: string[] | string;
}

export interface BoApprovalNames {
  supertype: string;
  subtype: string;
  base: string;
  event: string;
  displayMethod: string;
  updateMethod: string;
  statusParam: string;
  table: string;
  functionGroup: string;
  updateFm: string;
  raiseFm: string;
  wfAbbrev: string;
  tsDisplayAbbrev: string;
  tsUpdateAbbrev: string;
}

const Z_NAME = /^[ZY][A-Z0-9_]*$/;
const BOR_NAME = /^[A-Z0-9_]+$/;

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).replace(/_+$/, '') : s;
}

function checkZ(label: string, value: string, max: number): string {
  const v = value.toUpperCase().trim();
  if (!Z_NAME.test(v)) throw new Error(`${label} "${value}" must start with Z or Y and contain only A-Z, 0-9 and _`);
  if (v.length > max) throw new Error(`${label} "${v}" is longer than ${max} characters`);
  return v;
}

/** Derive every object name from the subtype, applying overrides and SAP length limits. */
export function deriveBoApprovalNames(input: BoApprovalInput): BoApprovalNames {
  const supertype = String(input.supertype || '').toUpperCase().trim();
  if (!supertype || !BOR_NAME.test(supertype) || supertype.length > 10) {
    throw new Error(`supertype "${input.supertype}" must be a BOR object type (max 10 chars), e.g. BUS2012`);
  }
  const subtype = checkZ('subtype', String(input.subtype || ''), 10);
  if (subtype === supertype) throw new Error('subtype must differ from supertype');

  // ZCUST_PO -> CUST_PO
  const base = subtype.replace(/^[ZY]/, '').replace(/^_+/, '') || subtype;
  const p = subtype[0];

  const event = String(input.event || 'ZCHANGED').toUpperCase().trim();
  if (!BOR_NAME.test(event) || event.length > 32) throw new Error(`event "${input.event}" must be A-Z/0-9/_ (max 32 chars)`);

  return {
    supertype,
    subtype,
    base,
    event,
    displayMethod: 'DISPLAYNEW',
    updateMethod: 'UPDATETABLE',
    statusParam: 'Status',
    table: checkZ('table', input.table || `${p}${cut(base, 11)}_APR`, 16),
    functionGroup: checkZ('functionGroup', input.functionGroup || `${p}${cut(base, 22)}_WF`, 26),
    updateFm: checkZ('updateFm', input.updateFm || `${p}${cut(base, 18)}_UPD_STATUS`, 30),
    raiseFm: checkZ('raiseFm', input.raiseFm || `${p}${cut(base, 19)}_RAISE_EVT`, 30),
    wfAbbrev: checkZ('wfAbbrev', input.wfAbbrev || `${p}${cut(base, 7)}_APR`, 12),
    tsDisplayAbbrev: checkZ('tsDisplayAbbrev', input.tsDisplayAbbrev || `${p}${cut(base, 6)}_DISP`, 12),
    tsUpdateAbbrev: checkZ('tsUpdateAbbrev', input.tsUpdateAbbrev || `${p}${cut(base, 7)}_UPD`, 12),
  };
}

/** ABAP field name used for a key field in the Z table / FM parameters (the DDIC field name). */
export function keyFieldName(k: BoKeyField): string {
  return k.refField.toLowerCase();
}

/** DDL type for a key field in the table source. */
function ddlType(k: BoKeyField): string {
  if (k.rollname) return k.rollname.toLowerCase();
  const len = k.length || 10;
  switch ((k.intType || 'C').toUpperCase()) {
    case 'N': return `abap.numc(${len})`;
    case 'D': return 'abap.dats';
    case 'T': return 'abap.tims';
    default:  return `abap.char(${len})`;
  }
}

/** ABAP TYPE clause for a key field (FM parameters, local structures). */
function abapType(k: BoKeyField): string {
  if (k.rollname) return k.rollname.toLowerCase();
  return `${k.refStruct.toLowerCase()}-${k.refField.toLowerCase()}`;
}

function assertKeys(keys: BoKeyField[]): void {
  if (!keys || keys.length === 0) throw new Error('the BO has no key fields (SWOTDV VERBTYPE = K) — check the supertype');
  const clash = keys.find(k => ['mandt', 'ardate', 'artime', 'status', 'descr', 'wf_id', 'ernam'].includes(keyFieldName(k)));
  if (clash) throw new Error(`key field ${clash.refField} clashes with a fixed column of the approval table`);
}

// ─── Z table ────────────────────────────────────────────────────────────────

export function buildApprovalTableSource(names: BoApprovalNames, keys: BoKeyField[]): string {
  assertKeys(keys);
  const width = Math.max(6, ...keys.map(k => keyFieldName(k).length));
  const pad = (s: string) => s.padEnd(width);
  const keyLines = keys.map(k => `  key ${pad(keyFieldName(k))} : ${ddlType(k)} not null;`).join('\n');
  return [
    `@EndUserText.label : 'WF ${names.subtype}: log de aprovacao/rejeicao'`,
    `@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE`,
    `@AbapCatalog.tableCategory : #TRANSPARENT`,
    `@AbapCatalog.deliveryClass : #A`,
    `@AbapCatalog.dataMaintenance : #RESTRICTED`,
    `define table ${names.table.toLowerCase()} {`,
    `  key ${pad('mandt')} : mandt not null;`,
    keyLines,
    `  key ${pad('ardate')} : sydats not null;`,
    `  key ${pad('artime')} : syuzeit not null;`,
    `      ${pad('status')} : abap.char(1);`,
    `      ${pad('descr')} : abap.char(40);`,
    `      ${pad('wf_id')} : sww_wiid;`,
    `      ${pad('ernam')} : ernam;`,
    ``,
    `}`,
  ].join('\n');
}

// ─── function modules ───────────────────────────────────────────────────────

function fmKeyParams(keys: BoKeyField[]): string {
  return keys.map(k => `    VALUE(iv_${keyFieldName(k)}) TYPE ${abapType(k)}`).join('\n');
}

/** Main table used for the existence check: only when every key field comes from the same table. */
export function mainTableOf(keys: BoKeyField[]): string | undefined {
  const t = keys[0]?.refStruct?.toUpperCase();
  return t && keys.every(k => k.refStruct.toUpperCase() === t) ? t : undefined;
}

export function buildUpdateFmSource(names: BoApprovalNames, keys: BoKeyField[]): string {
  assertKeys(keys);
  const main = mainTableOf(keys);
  const firstKey = keyFieldName(keys[0]);
  const where = keys.map(k => `${keyFieldName(k)} = @iv_${keyFieldName(k)}`).join('\n      AND ');
  const assign = keys.map(k => `  ls_log-${keyFieldName(k)} = iv_${keyFieldName(k)}.`).join('\n');
  const existence = main
    ? [
      `  SELECT SINGLE @abap_true FROM ${main.toLowerCase()}`,
      `    WHERE ${where}`,
      `    INTO @DATA(lv_exists).`,
      `  IF sy-subrc <> 0.`,
      `    MESSAGE e398(00) WITH 'Documento' iv_${firstKey} 'nao encontrado' space`,
      `      RAISING not_found.`,
      `  ENDIF.`,
      ``,
    ].join('\n')
    : `  " Key fields come from different tables: existence check left to the caller.\n\n`;

  return `FUNCTION ${names.updateFm.toLowerCase()}
  IMPORTING
${fmKeyParams(keys)}
    VALUE(iv_status) TYPE ${names.table.toLowerCase()}-status
    VALUE(iv_wf_id) TYPE sww_wiid OPTIONAL
  EXCEPTIONS
    invalid_status
    not_found
    update_failed.

*----------------------------------------------------------------------*
* Called by the background BOR method ${names.subtype}.${names.updateMethod}.
* Writes the user decision (A = approved / R = rejected).
* No COMMIT WORK: the workflow runtime commits the work item.
* Generated by sap-workflow-adt wf_bo_approval_scaffold.
*----------------------------------------------------------------------*

  DATA ls_log TYPE ${names.table.toLowerCase()}.

  IF iv_status <> 'A' AND iv_status <> 'R'.
    MESSAGE e398(00) WITH 'Status invalido:' iv_status 'documento' iv_${firstKey}
      RAISING invalid_status.
  ENDIF.

${existence}${assign}
  ls_log-ardate = sy-datum.
  ls_log-artime = sy-uzeit.
  ls_log-status = iv_status.
  ls_log-descr  = SWITCH #( iv_status
                            WHEN 'A' THEN 'Aprovado'
                            WHEN 'R' THEN 'Rejeitado' ).
  ls_log-wf_id  = iv_wf_id.
  ls_log-ernam  = sy-uname.

  " MODIFY: a second decision in the same second does not dump
  MODIFY ${names.table.toLowerCase()} FROM @ls_log.
  IF sy-subrc <> 0.
    MESSAGE e398(00) WITH 'Erro ao gravar ${names.table}' iv_${firstKey} space space
      RAISING update_failed.
  ENDIF.

ENDFUNCTION.`;
}

export function buildRaiseEventFmSource(names: BoApprovalNames, keys: BoKeyField[]): string {
  assertKeys(keys);
  const keyStruct = keys.length === 1
    ? `  lv_objkey = iv_${keyFieldName(keys[0])}.`
    : [
      `  " Composite key: fixed-width concatenation in SWOTDV key order`,
      `  DATA: BEGIN OF ls_key,`,
      ...keys.map((k, i) => `          ${keyFieldName(k)} TYPE ${abapType(k)}${i === keys.length - 1 ? ',' : ','}`),
      `        END OF ls_key.`,
      ...keys.map(k => `  ls_key-${keyFieldName(k)} = iv_${keyFieldName(k)}.`),
      `  lv_objkey = ls_key.`,
    ].join('\n');

  return `FUNCTION ${names.raiseFm.toLowerCase()}
  IMPORTING
${fmKeyParams(keys)}
  EXPORTING
    VALUE(ev_return_code) TYPE sysubrc.

*----------------------------------------------------------------------*
* Optional alternative to SWEC: raise ${names.subtype}.${names.event} from the
* document save (user exit / BAdI running BEFORE the standard COMMIT WORK).
* - commit_work = space: the event is written with the application LUW.
* - never COMMIT WORK here, never MESSAGE type E (would block the save).
* Generated by sap-workflow-adt wf_bo_approval_scaffold.
*----------------------------------------------------------------------*

  DATA: lv_objkey   TYPE swr_struct-object_key,
        lt_msglines TYPE STANDARD TABLE OF swr_messag.

${keyStruct}

  CALL FUNCTION 'SAP_WAPI_CREATE_EVENT'
    EXPORTING
      object_type   = '${names.subtype}'
      object_key    = lv_objkey
      event         = '${names.event}'
      commit_work   = space
    IMPORTING
      return_code   = ev_return_code
    TABLES
      message_lines = lt_msglines.

  IF ev_return_code <> 0.
    LOOP AT lt_msglines INTO DATA(ls_msg).
      MESSAGE s398(00) WITH 'Evento ${names.event} nao criado:' ls_msg-line
        DISPLAY LIKE 'W'.
      EXIT.
    ENDLOOP.
  ENDIF.

ENDFUNCTION.`;
}

// ─── display presets ────────────────────────────────────────────────────────

/** Built-in display presets. Only BUS2012 was verified end to end. */
export const DISPLAY_PRESETS: Record<string, BoDisplaySpec> = {
  BUS2012: {
    kind: 'fm',
    verified: true,
    fmCall: [
      `  CALL FUNCTION 'ME_DISPLAY_PURCHASE_DOCUMENT'`,
      `    EXPORTING`,
      `      i_ebeln = object-key-{key:PURCHASEORDER}`,
      `      i_enjoy = 'X'`,
      `    EXCEPTIONS`,
      `      not_found            = 1`,
      `      no_authority         = 2`,
      `      invalid_call         = 3`,
      `      preview_not_possible = 4`,
      `      OTHERS               = 5.`,
    ].join('\n'),
  },
  BUS2105: { kind: 'tcode', tcode: 'ME53N', paramIds: ['BAN'], verified: false },
  BUS2032: { kind: 'tcode', tcode: 'VA03', paramIds: ['AUN'], verified: false },
  BUS1001006: { kind: 'tcode', tcode: 'MM03', paramIds: ['MAT'], verified: false },
  BUS2081: { kind: 'tcode', tcode: 'MIR4', paramIds: ['RBN', 'GJR'], verified: false },
};

export function resolveDisplay(input: BoApprovalInput, supertype: string): BoDisplaySpec {
  if (input.displayFm) {
    return {
      kind: 'fm',
      verified: false,
      fmCall: `  CALL FUNCTION '${String(input.displayFm).toUpperCase()}'\n    EXPORTING\n      " TODO: map object-key-<field> to the FM parameters\n    EXCEPTIONS\n      OTHERS = 1.`,
      note: `Custom display FM ${String(input.displayFm).toUpperCase()}: complete the EXPORTING mapping before pasting.`,
    };
  }
  if (input.displayTcode) {
    const ids = Array.isArray(input.displayParamIds)
      ? input.displayParamIds
      : String(input.displayParamIds || '').split(',').map(s => s.trim()).filter(Boolean);
    return { kind: 'tcode', tcode: String(input.displayTcode).toUpperCase(), paramIds: ids.map(i => i.toUpperCase()), verified: false };
  }
  const preset = DISPLAY_PRESETS[supertype];
  if (preset) return preset;
  return {
    kind: 'todo',
    verified: false,
    note: `No display preset for ${supertype}. Pass displayFm or displayTcode + displayParamIds, or complete the TODO in the method.`,
  };
}

function displayBody(spec: BoDisplaySpec, keys: BoKeyField[]): string {
  if (spec.kind === 'fm') {
    return String(spec.fmCall).replace(/\{key:([A-Z0-9_]+)\}/g, (_m, verb) => {
      const k = keys.find(x => x.verb.toUpperCase() === verb) || keys[0];
      return k.verb.toLowerCase();
    }) + `\n  IF sy-subrc <> 0.\n    exit_return 9001 sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4.\n  ENDIF.`;
  }
  if (spec.kind === 'tcode') {
    const sets = (spec.paramIds || []).map((id, i) =>
      keys[i] ? `  SET PARAMETER ID '${id}' FIELD object-key-${keys[i].verb.toLowerCase()}.` : `  " TODO: SET PARAMETER ID '${id}' (no matching key field)`
    ).join('\n');
    return `${sets}
  TRY.
      CALL TRANSACTION '${spec.tcode}' WITH AUTHORITY-CHECK AND SKIP FIRST SCREEN.
    CATCH cx_sy_authorization_error.
      exit_return 9001 'Sem autorizacao para' '${spec.tcode}' space space.
  ENDTRY.`;
  }
  return `  " TODO: display the document for object-key-${keys[0].verb.toLowerCase()}
  "       (CALL FUNCTION ... or SET PARAMETER ID + CALL TRANSACTION ... AND SKIP FIRST SCREEN)`;
}

/** Code to paste into the BOR program of the subtype (SWO1 › Programa). */
export function buildBorMethodsSource(names: BoApprovalNames, keys: BoKeyField[], spec: BoDisplaySpec): string {
  assertKeys(keys);
  const exporting = keys.map(k => `      iv_${keyFieldName(k)} = object-key-${k.verb.toLowerCase()}`).join('\n');
  return `BEGIN_METHOD ${names.displayMethod} CHANGING CONTAINER.
${displayBody(spec, keys)}
END_METHOD.

BEGIN_METHOD ${names.updateMethod} CHANGING CONTAINER.
  DATA lv_status TYPE ${names.table.toLowerCase()}-status.
  swc_get_element container '${names.statusParam}' lv_status.
  CALL FUNCTION '${names.updateFm}'
    EXPORTING
${exporting}
      iv_status = lv_status
    EXCEPTIONS
      invalid_status = 1
      not_found      = 2
      update_failed  = 3
      OTHERS         = 4.
  IF sy-subrc <> 0.
    exit_return 9001 sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4.
  ENDIF.
END_METHOD.`;
}

// ─── SAP GUI guide ──────────────────────────────────────────────────────────

export interface GuideContext {
  cdObject?: string;
  client?: string;
  keys: BoKeyField[];
  display: BoDisplaySpec;
}

export interface GuideStep {
  tcode: string;
  title: string;
  actions: string[];
}

/** Ordered SAP GUI steps (PT-BR GUI labels) for everything ADT cannot create. */
export function buildGuiGuide(names: BoApprovalNames, ctx: GuideContext): GuideStep[] {
  const keyList = ctx.keys.map(k => `${k.verb} (${k.refStruct}-${k.refField})`).join(', ');
  const cd = ctx.cdObject || '<objeto de change document>';
  return [
    {
      tcode: 'SWO1',
      title: `Subtipo ${names.subtype} de ${names.supertype}`,
      actions: [
        `Tp.obj. = ${names.supertype} → botão Subtipo → Tipo de objeto ${names.subtype}, Programa ${names.subtype}, Aplicação conforme o módulo → ✔ → Objeto local (ou pacote/ordem).`,
        `Chave herdada: ${keyList}.`,
        `Eventos → Criar → ${names.event}.`,
        `Métodos → Criar ("com FM como modelo?" Não): ${names.displayMethod} com Diálogo ✔ e Síncrono ✔; ${names.updateMethod} com Diálogo DESMARCADO.`,
        `${names.updateMethod} → Parâmetro → Criar ("com campo ABAP Dictionary?" Sim) → tabela ${names.table}, campo STATUS → nome ${names.statusParam}, Importação ✔, obrigatório ✔.`,
        `Cada método → Exceções → Criar 9001, Erro de aplicação, área 00, mensagem 398.`,
        `Salvar. ${names.displayMethod} → Programa → "gerar padrão?" Sim (pode perguntar 2x) → colar o código de borMethodsSource → Ctrl+F2 → salvar → F3.`,
        `Processar › Modificar status da liberação › Componente tp.objeto › Em implementado (os 2 métodos e o evento); depois › Tipo de objeto › Em implementado.`,
        `Gerar (Ctrl+F3). Não criar delegação em sistema compartilhado sem autorização (só existe uma por supertipo).`,
      ],
    },
    {
      tcode: 'SWEC',
      title: 'Disparo do evento no save (sem código)',
      actions: [
        `Entradas novas: Objeto doc.modif. ${cd}, Categoria BO, Tipo ${names.subtype}, Evento ${names.event}, Ao modif. → salvar (ordem de workbench; tabela cross-client).`,
        `Alternativa com código: chamar ${names.raiseFm} numa exit/BAdI do save (gerado com includeRaiseFm=true).`,
      ],
    },
    {
      tcode: 'SWDD',
      title: `Template ${names.wfAbbrev}`,
      actions: [
        `Ctrl+S → Sigla ${names.wfAbbrev} + denominação. "Erro de sistema: função cancelada" = falta número de prefixo (OOW4).`,
        `Etapa "não determinado" → Atividade → menu da tarefa › Criar tarefa: sigla ${names.tsDisplayAbbrev}, Tipo ${names.subtype}, Método ${names.displayMethod} → salvar → Dados adicionais › Atribuição do responsável › Atualizar › Tarefa geral.`,
        `Voltar (F3 2x) → aceitar binding &${names.subtype}& → _WI_OBJECT_ID. Responsável: Expressão ("Impressão" no GUI PT) &_WF_INITIATOR&.`,
        `Painel "Container de workflow": criar STATUS (Ref. ABAP Dictionary ${names.table}-STATUS); abrir o elemento ${names.subtype} → Caracts. → Importação ✔.`,
        `Arrastar "Decisão do usuário" abaixo da atividade: título, responsável &_WF_INITIATOR&, opções Aprovar/Rejeitar.`,
        `Em cada resultado: Operação de container, Elem.resultado STATUS (sem &), Expressão A (aprovado) / R (rejeitado).`,
        `Arrastar Atividade para depois da junção → Criar tarefa ${names.tsUpdateAbbrev}, método ${names.updateMethod}, Processamento em background ✔ → aceitar binding &STATUS& → STATUS e &${names.subtype}& → _WI_OBJECT_ID.`,
        `Ctrl+F8 › Independente versão › Eventos iniciais: BO ${names.subtype} / ${names.event}. Gravar o WF antes do binding; binding _EVT_OBJECT → ${names.subtype}; coluna Atv (pede ordem de customizing).`,
        `Gravar e Ativar (Ctrl+F3).`,
      ],
    },
    {
      tcode: 'SWUE / SWI1 / SBWP',
      title: 'Teste',
      actions: [
        `SWUE: Tipo ${names.subtype}, Evento ${names.event}, chave de um documento existente${ctx.client ? ` no mandante ${ctx.client}` : ''} → Determinar receptor (WS "0 sem erros") → Gerar evento.`,
        `SWI1 / SBWP › Entrada › Workflow → executar a exibição → decidir → SE16 ${names.table}.`,
        `Receptor achado mas nada na SWI1 → SWU3 (destino RFC WORKFLOW_LOCAL_<mandante>) ou SM58.`,
      ],
    },
  ];
}
