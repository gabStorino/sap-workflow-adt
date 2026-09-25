/**
 * Source generators for SAP Business Workflow ABAP objects.
 *
 * Pure functions (no SAP access) so they can be unit-tested and previewed.
 * The generated class follows the recipe of "ABAP Development for SAP Business
 * Workflow" (Werner, SAP PRESS), chapter 7:
 *   - IF_WORKFLOW with a CHAR key <= 32 (GUID by default)
 *   - private instantiation + factories (CREATE / GET_INSTANCE / DELETE_INSTANCE)
 *   - instance management table; GET_INSTANCE goes through BI_PERSISTENT~FIND_BY_LPOR
 *   - prototype persistence: IF_SERIALIZABLE_OBJECT + CALL TRANSFORMATION id + data cluster
 *   - exceptions inheriting CX_BO_ERROR / CX_BO_TEMPORARY with T100 texts
 *   - workflow events CREATED / CHANGED / DELETED raised via CL_SWF_EVT_EVENT
 *
 * ABAP rules learned the hard way (kept in the templates):
 *   - no "*" comment lines between METHOD blocks (source-based class editor rejects them)
 *   - EXPORT/IMPORT ... ID needs a variable, not a functional method call
 *   - cluster ID (INDX-SRTFD) is max 22 chars -> GUID-22 conversion
 */

export interface WfScaffoldNames {
  className: string;
  errorClass: string;
  tempClass: string;
  messageClass: string;
  clusterTable: string;
  relid: string;
  keyField: string;
}

export interface WfScaffoldInput {
  className: string;
  description: string;
  errorClass?: string;
  tempClass?: string;
  messageClass?: string;
  clusterTable?: string;
  relid?: string;
  keyField?: string;
}

export interface WfMessage {
  number: string;
  text: string;
  selfExplanatory?: boolean;
}

const NAME_RE = /^[ZY][A-Z0-9_]*$/;

/** Derive all object names from the class name, applying overrides and SAP length limits. */
export function deriveWfNames(input: WfScaffoldInput): WfScaffoldNames {
  const className = (input.className || '').toUpperCase().trim();
  if (!NAME_RE.test(className)) {
    throw new Error(`className "${input.className}" must start with Z or Y and contain only A-Z, 0-9 and _`);
  }
  if (className.length > 30) throw new Error(`className "${className}" is longer than 30 characters`);

  // ZCL_WF_ZIP -> WF_ZIP ; YCL_FOO -> FOO ; ZMY_CLASS -> MY_CLASS
  const base = className.replace(/^[ZY](CL_)?/, '');
  const prefix = className[0];

  const errorClass = (input.errorClass || `${prefix}CX_${base}_ERROR`).toUpperCase();
  const tempClass = (input.tempClass || `${prefix}CX_${base}_TEMP`).toUpperCase();
  const messageClass = (input.messageClass || `${prefix}${base}`).toUpperCase();
  const clusterTable = (input.clusterTable || `${prefix}WF_XML_INDX`).toUpperCase();
  const relid = (input.relid || defaultRelid(className)).toUpperCase();
  const keyField = (input.keyField || 'OBJECT_ID').toUpperCase();

  for (const [label, value, max] of [
    ['errorClass', errorClass, 30], ['tempClass', tempClass, 30],
    ['messageClass', messageClass, 20], ['clusterTable', clusterTable, 16],
  ] as Array<[string, string, number]>) {
    if (!NAME_RE.test(value)) throw new Error(`${label} "${value}" must start with Z or Y and contain only A-Z, 0-9 and _`);
    if (value.length > max) {
      throw new Error(`${label} "${value}" is longer than ${max} characters — pass ${label} explicitly with a shorter name`);
    }
  }
  if (!/^[A-Z0-9]{2}$/.test(relid)) throw new Error(`relid "${relid}" must be exactly 2 characters (A-Z, 0-9)`);
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(keyField)) throw new Error(`keyField "${keyField}" is not a valid ABAP attribute name`);

  return { className, errorClass, tempClass, messageClass, clusterTable, relid, keyField };
}

/** Stable 2-char cluster area derived from the class name, so several classes can share one table. */
export function defaultRelid(className: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let h = 7;
  for (const c of className.toUpperCase()) h = (h * 31 + c.charCodeAt(0)) % 1_000_003;
  return 'Z' + chars[h % chars.length];
}

/** Messages the scaffolded exceptions reference (numbers 000-003). */
export function wfDefaultMessages(): WfMessage[] {
  return [
    { number: '000', text: '&1&2&3&4', selfExplanatory: true },
    { number: '001', text: 'Object &1 not found in persistence', selfExplanatory: true },
    { number: '002', text: 'Object &1 is locked by user &2 - try again later', selfExplanatory: true },
    { number: '003', text: 'Error saving object &1', selfExplanatory: true },
  ];
}

function t100Const(name: string, msgClass: string, msgno: string, attrs: string[]): string {
  const a = [...attrs, '', '', '', ''].slice(0, 4);
  return `      BEGIN OF ${name},
        msgid TYPE symsgid VALUE '${msgClass}',
        msgno TYPE symsgno VALUE '${msgno}',
        attr1 TYPE scx_attrname VALUE '${a[0]}',
        attr2 TYPE scx_attrname VALUE '${a[1]}',
        attr3 TYPE scx_attrname VALUE '${a[2]}',
        attr4 TYPE scx_attrname VALUE '${a[3]}',
      END OF ${name}`;
}

/** Exception class inheriting CX_BO_ERROR or CX_BO_TEMPORARY, with IF_T100_MESSAGE texts. */
export function buildWfExceptionSource(
  exceptionName: string,
  kind: 'error' | 'temporary',
  names: WfScaffoldNames
): string {
  const cls = exceptionName.toLowerCase();
  const parent = kind === 'error' ? 'cx_bo_error' : 'cx_bo_temporary';
  const title = kind === 'error'
    ? `${names.className}: erro definitivo (workflow vai para ERROR)`
    : `${names.className}: erro temporario (engine tenta de novo)`;
  const consts = kind === 'error'
    ? [
        t100Const('generic', names.messageClass, '000', ['MSGV1', 'MSGV2', 'MSGV3', 'MSGV4']),
        t100Const('not_found', names.messageClass, '001', ['OBJECT_ID']),
        t100Const('save_error', names.messageClass, '003', ['OBJECT_ID']),
      ]
    : [
        t100Const('generic', names.messageClass, '000', ['MSGV1', 'MSGV2', 'MSGV3', 'MSGV4']),
        t100Const('locked', names.messageClass, '002', ['OBJECT_ID', 'LOCK_USER']),
      ];

  return `"! <p class="shorttext synchronized">${title}</p>
CLASS ${cls} DEFINITION
  PUBLIC
  INHERITING FROM ${parent}
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_t100_message.

    CONSTANTS:
${consts.join(',\n')}.

    DATA object_id TYPE string READ-ONLY.
    DATA lock_user TYPE syuname READ-ONLY.
    DATA msgv1     TYPE symsgv READ-ONLY.
    DATA msgv2     TYPE symsgv READ-ONLY.
    DATA msgv3     TYPE symsgv READ-ONLY.
    DATA msgv4     TYPE symsgv READ-ONLY.

    METHODS constructor
      IMPORTING
        textid     LIKE if_t100_message=>t100key OPTIONAL
        previous   LIKE previous OPTIONAL
        class_name TYPE seoclname OPTIONAL
        instance   TYPE REF TO bi_object OPTIONAL
        object_id  TYPE csequence OPTIONAL
        lock_user  TYPE syuname OPTIONAL
        msgv1      TYPE symsgv OPTIONAL
        msgv2      TYPE symsgv OPTIONAL
        msgv3      TYPE symsgv OPTIONAL
        msgv4      TYPE symsgv OPTIONAL.

ENDCLASS.



CLASS ${cls} IMPLEMENTATION.

  METHOD constructor ##ADT_SUPPRESS_GENERATION.
    super->constructor( previous   = previous
                        class_name = class_name
                        instance   = instance ).
    me->object_id = object_id.
    me->lock_user = lock_user.
    me->msgv1     = msgv1.
    me->msgv2     = msgv2.
    me->msgv3     = msgv3.
    me->msgv4     = msgv4.

    CLEAR me->textid.
    IF textid IS INITIAL.
      if_t100_message~t100key = generic.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
  ENDMETHOD.

ENDCLASS.`;
}

/** Data cluster table (copy of INDX) in DDL source form. */
export function buildClusterTableSource(tableName: string): string {
  return `@EndUserText.label : 'Workflow: data cluster p/ objetos XML (copia INDX)'
@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table ${tableName.toLowerCase()} {
  key mandt : mandt not null;
  key relid : indx_relid not null;
  key srtfd : indx_srtfd not null;
  key srtf2 : indx_srtf2 not null;
  loekz     : sychar01;
  sperr     : sychar01;
  aedat     : sydats;
  usera     : username;
  pgmid     : progname;
  begdt     : sydats;
  enddt     : sydats;
  clustr    : indx_clstr;
  clustd    : indx_clust;

}`;
}

/** The workflow-ready class (business logic left as TODOs inside methods). */
export function buildWfClassSource(input: WfScaffoldInput, names: WfScaffoldNames): string {
  const cls = names.className.toLowerCase();
  const err = names.errorClass.toLowerCase();
  const tmp = names.tempClass.toLowerCase();
  const tab = names.clusterTable.toLowerCase();
  const key = names.keyField.toLowerCase();
  const desc = (input.description || names.className).replace(/[<>]/g, '');

  return `"! <p class="shorttext synchronized">${desc}</p>
"! Classe workflow-ready gerada por sap-workflow-adt (wf_class_scaffold).
"! Receita: IF_WORKFLOW + chave CHAR32 (GUID) + instanciacao privada com factories,
"! gestao de instancias via FIND_BY_LPOR, persistencia prototipo em data cluster
"! ${names.clusterTable} (RELID ${names.relid}), excecoes ${names.errorClass} / ${names.tempClass}.
"! Os metodos NAO fazem COMMIT WORK: no workflow o engine faz; fora dele, o chamador.
CLASS ${cls} DEFINITION
  PUBLIC
  FINAL
  CREATE PRIVATE.

  PUBLIC SECTION.
    INTERFACES if_workflow.
    INTERFACES if_serializable_object.

    CONSTANTS c_objtype TYPE sibftypeid VALUE '${names.className}'.

    "! Chave (key attribute) - GUID CHAR32
    DATA ${key} TYPE sysuuid_c32 READ-ONLY.
    "! Texto de uma linha para logs/textos de work item (default attribute)
    DATA description TYPE text80 READ-ONLY.
    DATA created_by  TYPE syuname READ-ONLY.
    DATA created_at  TYPE timestamp READ-ONLY.
    DATA changed_by  TYPE syuname READ-ONLY.
    DATA changed_at  TYPE timestamp READ-ONLY.

    "! Evento de workflow: objeto criado
    EVENTS created.
    "! Evento de workflow: objeto alterado
    EVENTS changed.
    "! Evento de workflow: objeto apagado
    EVENTS deleted.

    "! Factory: cria um objeto novo (novo GUID) e persiste
    CLASS-METHODS create
      RETURNING
        VALUE(ro_object) TYPE REF TO ${cls}
      RAISING
        ${err}
        ${tmp}.

    "! Factory: instancia unica por chave. Chave vazia = cria novo.
    "! Passa por BI_PERSISTENT~FIND_BY_LPOR - o mesmo caminho do engine.
    CLASS-METHODS get_instance
      IMPORTING
        iv_${key} TYPE sysuuid_c32 OPTIONAL
      RETURNING
        VALUE(ro_object) TYPE REF TO ${cls}
      RAISING
        ${err}
        ${tmp}.

    "! Apaga o objeto persistido e libera a instancia
    CLASS-METHODS delete_instance
      IMPORTING
        iv_${key} TYPE sysuuid_c32
      RAISING
        ${err}
        ${tmp}.

    "! Grava o estado atual e dispara o evento CHANGED
    METHODS save
      RAISING
        ${err}
        ${tmp}.

    "! Apaga os dados de negocio e dispara DELETED
    METHODS delete
      RAISING
        ${err}
        ${tmp}.

    "! Default method (duplo clique no work item)
    METHODS display.

  PROTECTED SECTION.

  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_instance,
        ${key} TYPE sysuuid_c32,
        instance TYPE REF TO ${cls},
      END OF ty_instance,
      tt_instances TYPE SORTED TABLE OF ty_instance WITH UNIQUE KEY ${key}.
    TYPES:
      BEGIN OF ty_store,
        ${key} TYPE sysuuid_c32,
        xml    TYPE xstring,
      END OF ty_store.

    CONSTANTS c_relid TYPE indx_relid VALUE '${names.relid}'.

    " Gestao de instancias: uma referencia por chave ate BI_OBJECT~RELEASE
    CLASS-DATA mst_instances TYPE tt_instances.

    METHODS constructor
      IMPORTING
        iv_${key} TYPE sysuuid_c32.

    METHODS recalculate.

    METHODS serialize
      RAISING
        ${err}.

    CLASS-METHODS deserialize
      IMPORTING
        iv_${key}      TYPE sysuuid_c32
      RETURNING
        VALUE(ro_object) TYPE REF TO ${cls}.

    CLASS-METHODS cluster_id
      IMPORTING
        iv_${key}    TYPE sysuuid_c32
      RETURNING
        VALUE(rv_id) TYPE indx_srtfd.

    METHODS enqueue
      RAISING
        ${tmp}.

    METHODS dequeue.

    METHODS raise_wf_event
      IMPORTING
        iv_event TYPE sibfevent.

ENDCLASS.



CLASS ${cls} IMPLEMENTATION.

  METHOD create.
    " Factory: novo GUID, instancia privada, persiste, evento CREATED
    DATA lv_id TYPE sysuuid_c32.

    TRY.
        lv_id = cl_system_uuid=>create_uuid_c32_static( ).
      CATCH cx_uuid_error INTO DATA(lx_uuid).
        RAISE EXCEPTION TYPE ${err}
          EXPORTING
            previous = lx_uuid
            msgv1    = 'GUID'.
    ENDTRY.

    ro_object = NEW #( lv_id ).
    ro_object->created_by = sy-uname.
    GET TIME STAMP FIELD ro_object->created_at.
    " TODO: inicialize aqui os atributos de negocio
    ro_object->recalculate( ).
    ro_object->serialize( ).

    INSERT VALUE #( ${key} = lv_id instance = ro_object ) INTO TABLE mst_instances.
    ro_object->raise_wf_event( 'CREATED' ).
  ENDMETHOD.


  METHOD get_instance.
    DATA ls_lpor TYPE sibflpor.

    IF iv_${key} IS INITIAL.
      ro_object = create( ).
      RETURN.
    ENDIF.

    ls_lpor-catid  = 'CL'.
    ls_lpor-typeid = c_objtype.
    ls_lpor-instid = iv_${key}.
    ro_object ?= ${cls}=>bi_persistent~find_by_lpor( ls_lpor ).

    IF ro_object IS NOT BOUND.
      RAISE EXCEPTION TYPE ${err}
        EXPORTING
          textid    = ${err}=>not_found
          object_id = iv_${key}.
    ENDIF.
  ENDMETHOD.


  METHOD delete_instance.
    get_instance( iv_${key} )->delete( ).
  ENDMETHOD.


  METHOD constructor.
    " Constructor = setar chave + REFRESH (usado so por CREATE)
    me->${key} = iv_${key}.
    me->bi_persistent~refresh( ).
  ENDMETHOD.


  METHOD bi_persistent~find_by_lpor.
    " Tabela estatica -> senao reconstroi da persistencia (data cluster)
    DATA lv_id TYPE sysuuid_c32.

    lv_id = lpor-instid.
    IF lv_id IS INITIAL.
      RETURN.
    ENDIF.

    READ TABLE mst_instances INTO DATA(ls_inst) WITH TABLE KEY ${key} = lv_id.
    IF sy-subrc <> 0.
      ls_inst-${key}   = lv_id.
      ls_inst-instance = deserialize( lv_id ).
      IF ls_inst-instance IS NOT BOUND.
        RETURN.
      ENDIF.
      INSERT ls_inst INTO TABLE mst_instances.
    ENDIF.

    result = ls_inst-instance.
  ENDMETHOD.


  METHOD bi_persistent~lpor.
    result-catid  = 'CL'.
    result-typeid = c_objtype.
    result-instid = me->${key}.
  ENDMETHOD.


  METHOD bi_persistent~refresh.
    " Rele o estado persistido (outra sessao pode ter alterado) e recalcula
    DATA ls_store TYPE ty_store.
    DATA lo_copy  TYPE REF TO ${cls}.

    IF me->${key} IS INITIAL.
      RETURN.
    ENDIF.

    DATA(lv_cid) = cluster_id( me->${key} ).
    IMPORT store = ls_store FROM DATABASE ${tab}(${names.relid.toLowerCase()}) ID lv_cid.
    IF sy-subrc = 0.
      TRY.
          CALL TRANSFORMATION id
            SOURCE XML ls_store-xml
            RESULT obj = lo_copy.
          IF lo_copy IS BOUND.
            me->created_by = lo_copy->created_by.
            me->created_at = lo_copy->created_at.
            me->changed_by = lo_copy->changed_by.
            me->changed_at = lo_copy->changed_at.
            " TODO: copie aqui os atributos de negocio de LO_COPY
          ENDIF.
        CATCH cx_transformation_error.
          " mantem o estado em memoria
      ENDTRY.
    ENDIF.

    recalculate( ).
  ENDMETHOD.


  METHOD bi_object~default_attribute_value.
    GET REFERENCE OF me->description INTO result.
  ENDMETHOD.


  METHOD bi_object~execute_default_method.
    display( ).
  ENDMETHOD.


  METHOD bi_object~release.
    " Limpeza TECNICA apenas - nunca apagar dados de negocio aqui
    DELETE TABLE mst_instances WITH TABLE KEY ${key} = me->${key}.
    CLEAR me->${key}.
  ENDMETHOD.


  METHOD save.
    enqueue( ).
    TRY.
        me->changed_by = sy-uname.
        GET TIME STAMP FIELD me->changed_at.
        recalculate( ).
        serialize( ).
      CLEANUP.
        dequeue( ).
    ENDTRY.
    dequeue( ).
    raise_wf_event( 'CHANGED' ).
  ENDMETHOD.


  METHOD delete.
    enqueue( ).
    DATA(lv_cid) = cluster_id( me->${key} ).
    DELETE FROM DATABASE ${tab}(${names.relid.toLowerCase()}) ID lv_cid.
    dequeue( ).
    raise_wf_event( 'DELETED' ).
    me->bi_object~release( ).
  ENDMETHOD.


  METHOD display.
    " TODO: exibicao em dialog (ex.: CL_SALV_TABLE popup). Sem GUI em background.
    IF sy-batch = abap_true.
      RETURN.
    ENDIF.
    MESSAGE me->description TYPE 'I'.
  ENDMETHOD.


  METHOD recalculate.
    " TODO: recalcule aqui atributos derivados
    description = |${names.className} { ${key} }|.
  ENDMETHOD.


  METHOD raise_wf_event.
    " Entregue no proximo COMMIT WORK
    DATA lv_key TYPE sibfinstid.
    lv_key = me->${key}.
    TRY.
        cl_swf_evt_event=>get_instance(
          im_objcateg = cl_swf_evt_event=>mc_objcateg_cl
          im_objtype  = c_objtype
          im_event    = iv_event
          im_objkey   = lv_key )->raise( ).
      CATCH cx_swf_evt_invalid_objtype cx_swf_evt_invalid_event.
        " evento e opcional para o negocio - nao interrompe o processamento
    ENDTRY.
  ENDMETHOD.


  METHOD serialize.
    " Prototipo: XML (CALL TRANSFORMATION id) em data cluster. Para produtivo,
    " troque so SERIALIZE / DESERIALIZE / DELETE pela persistencia real.
    DATA ls_store TYPE ty_store.

    ls_store-${key} = me->${key}.
    TRY.
        CALL TRANSFORMATION id
          SOURCE obj = me
          RESULT XML ls_store-xml.
      CATCH cx_transformation_error INTO DATA(lx_trafo).
        RAISE EXCEPTION TYPE ${err}
          EXPORTING
            textid    = ${err}=>save_error
            previous  = lx_trafo
            object_id = me->${key}
            instance  = me.
    ENDTRY.

    DATA(ls_indx) = VALUE ${tab}( aedat = sy-datum
                                  usera = sy-uname
                                  pgmid = sy-repid ).
    DATA(lv_cid) = cluster_id( me->${key} ).
    EXPORT store = ls_store TO DATABASE ${tab}(${names.relid.toLowerCase()}) FROM ls_indx ID lv_cid.
  ENDMETHOD.


  METHOD deserialize.
    DATA ls_store TYPE ty_store.

    DATA(lv_cid) = cluster_id( iv_${key} ).
    IMPORT store = ls_store FROM DATABASE ${tab}(${names.relid.toLowerCase()}) ID lv_cid.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    TRY.
        " a transformacao NAO chama o constructor ...
        CALL TRANSFORMATION id
          SOURCE XML ls_store-xml
          RESULT obj = ro_object.
      CATCH cx_transformation_error.
        CLEAR ro_object.
        RETURN.
    ENDTRY.

    IF ro_object IS BOUND.
      " ... por isso recalcular atributos (e registrar handlers, se houver)
      ro_object->recalculate( ).
    ENDIF.
  ENDMETHOD.


  METHOD cluster_id.
    " ID do data cluster: no maximo 22 caracteres -> GUID-22
    TRY.
        cl_system_uuid=>convert_uuid_c32_static(
          EXPORTING uuid     = iv_${key}
          IMPORTING uuid_c22 = DATA(lv_c22) ).
        rv_id = lv_c22.
      CATCH cx_uuid_error.
        rv_id = iv_${key}(22).
    ENDTRY.
  ENDMETHOD.


  METHOD enqueue.
    " Bloqueio ocupado = erro TEMPORARIO (engine tenta de novo)
    DATA lv_varkey TYPE rstable-varkey.

    lv_varkey = |{ sy-mandt }{ c_relid }{ cluster_id( me->${key} ) }|.
    CALL FUNCTION 'ENQUEUE_E_TABLE'
      EXPORTING
        tabname        = '${names.clusterTable}'
        varkey         = lv_varkey
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE ${tmp}
        EXPORTING
          textid    = ${tmp}=>locked
          object_id = me->${key}
          lock_user = CONV #( sy-msgv1 )
          instance  = me.
    ENDIF.
  ENDMETHOD.


  METHOD dequeue.
    DATA lv_varkey TYPE rstable-varkey.

    lv_varkey = |{ sy-mandt }{ c_relid }{ cluster_id( me->${key} ) }|.
    CALL FUNCTION 'DEQUEUE_E_TABLE'
      EXPORTING
        tabname = '${names.clusterTable}'
        varkey  = lv_varkey.
  ENDMETHOD.

ENDCLASS.`;
}

/** ABAP Unit test include for the generated class. */
export function buildWfTestSource(names: WfScaffoldNames): string {
  const cls = names.className.toLowerCase();
  const err = names.errorClass.toLowerCase();
  const key = names.keyField.toLowerCase();
  return `*"* Testes ABAP Unit gerados por sap-workflow-adt (wf_class_scaffold)
*"* Sem COMMIT: o ABAP Unit faz ROLLBACK no fim, entao o data cluster fica limpo.
CLASS ltc_wf DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS create_and_key        FOR TESTING RAISING cx_static_check.
    METHODS same_key_same_ref     FOR TESTING RAISING cx_static_check.
    METHODS rebuild_after_release FOR TESTING RAISING cx_static_check.
    METHODS lpor_is_consistent    FOR TESTING RAISING cx_static_check.
    METHODS not_found_after_delete FOR TESTING RAISING cx_static_check.
ENDCLASS.


CLASS ltc_wf IMPLEMENTATION.

  METHOD create_and_key.
    DATA(lo_obj) = ${cls}=>create( ).
    cl_abap_unit_assert=>assert_not_initial( lo_obj->${key} ).
  ENDMETHOD.


  METHOD same_key_same_ref.
    DATA(lo_obj) = ${cls}=>create( ).
    DATA(lo_again) = ${cls}=>get_instance( lo_obj->${key} ).
    cl_abap_unit_assert=>assert_true( xsdbool( lo_again = lo_obj ) ).
  ENDMETHOD.


  METHOD rebuild_after_release.
    DATA(lo_obj) = ${cls}=>create( ).
    DATA(lv_id) = lo_obj->${key}.
    lo_obj->bi_object~release( ).
    DATA(lo_new) = ${cls}=>get_instance( lv_id ).
    cl_abap_unit_assert=>assert_true( xsdbool( lo_new <> lo_obj ) ).
    cl_abap_unit_assert=>assert_equals( act = lo_new->${key} exp = lv_id ).
  ENDMETHOD.


  METHOD lpor_is_consistent.
    DATA(lo_obj) = ${cls}=>create( ).
    DATA(ls_lpor) = lo_obj->bi_persistent~lpor( ).
    cl_abap_unit_assert=>assert_equals( act = ls_lpor-catid  exp = 'CL' ).
    cl_abap_unit_assert=>assert_equals( act = ls_lpor-typeid exp = '${names.className}' ).
    DATA(lo_found) = ${cls}=>bi_persistent~find_by_lpor( ls_lpor ).
    cl_abap_unit_assert=>assert_true( xsdbool( lo_found = lo_obj ) ).
  ENDMETHOD.


  METHOD not_found_after_delete.
    DATA(lv_id) = ${cls}=>create( )->${key}.
    ${cls}=>delete_instance( lv_id ).
    TRY.
        ${cls}=>get_instance( lv_id ).
        cl_abap_unit_assert=>fail( 'objeto apagado ainda encontrado' ).
      CATCH ${err} INTO DATA(lx).
        cl_abap_unit_assert=>assert_equals( act = lx->if_t100_message~t100key-msgno exp = '001' ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.`;
}

/** XML body for PUT /sap/bc/adt/messageclass/{name}. */
export function buildMessageClassXml(opts: {
  name: string;
  description: string;
  masterLanguage?: string;
  packageName?: string;
  messages: WfMessage[];
}): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const msgs = [...opts.messages]
    .sort((a, b) => a.number.localeCompare(b.number))
    .map(m =>
      `<mc:messages mc:msgno="${esc(normalizeMsgNo(m.number))}" mc:msgtext="${esc(m.text)}" ` +
      `mc:selfexplainatory="${m.selfExplanatory === false ? 'false' : 'true'}" mc:documented="false" adtcore:name=""/>`)
    .join('');
  const pkg = opts.packageName ? `<adtcore:packageRef adtcore:name="${esc(opts.packageName.toUpperCase())}"/>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${esc(opts.name.toUpperCase())}" adtcore:type="MSAG/N" adtcore:description="${esc(opts.description)}" ` +
    `adtcore:masterLanguage="${esc(opts.masterLanguage || 'EN')}" adtcore:language="${esc(opts.masterLanguage || 'EN')}">` +
    pkg + msgs + `</mc:messageClass>`;
}

/** Parse the messages out of a GET /sap/bc/adt/messageclass/{name} response. */
export function parseMessageClassXml(xml: string): {
  description: string; masterLanguage: string; packageName: string; messages: WfMessage[];
} {
  const unesc = (s: string) => s
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`));
    return m ? unesc(m[1]) : '';
  };
  const rootTag = (xml.match(/<mc:messageClass\b[^>]*>/) || [''])[0];
  const pkgTag = (xml.match(/<adtcore:packageRef\b[^>]*>/) || [''])[0];
  const messages: WfMessage[] = [];
  for (const m of xml.matchAll(/<mc:messages\b[^>]*>/g)) {
    const tag = m[0];
    messages.push({
      number: attr(tag, 'mc:msgno'),
      text: attr(tag, 'mc:msgtext'),
      selfExplanatory: attr(tag, 'mc:selfexplainatory') !== 'false',
    });
  }
  return {
    description: attr(rootTag, 'adtcore:description'),
    masterLanguage: attr(rootTag, 'adtcore:masterLanguage') || 'EN',
    packageName: attr(pkgTag, 'adtcore:name'),
    messages,
  };
}

/** "1" -> "001"; validates 0-999. */
export function normalizeMsgNo(n: string | number): string {
  const s = String(n).trim();
  if (!/^\d{1,3}$/.test(s)) throw new Error(`message number "${n}" must be 000-999`);
  return s.padStart(3, '0');
}

/** Merge new messages over existing ones by number (new wins). */
export function mergeMessages(existing: WfMessage[], incoming: WfMessage[]): WfMessage[] {
  const map = new Map<string, WfMessage>();
  for (const m of existing) map.set(normalizeMsgNo(m.number), { ...m, number: normalizeMsgNo(m.number) });
  for (const m of incoming) {
    if ((m.text || '').length > 73) throw new Error(`message ${m.number}: text longer than 73 characters`);
    map.set(normalizeMsgNo(m.number), { ...m, number: normalizeMsgNo(m.number) });
  }
  return [...map.values()].sort((a, b) => a.number.localeCompare(b.number));
}

/** XML body for POST /sap/bc/adt/packages (packages.v2). */
export function buildPackageXml(opts: {
  name: string;
  description: string;
  superPackage?: string;
  softwareComponent?: string;
  transportLayer?: string;
  packageType?: 'development' | 'structure' | 'main';
  language?: string;
}): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const name = esc(opts.name.toUpperCase());
  const lang = esc(opts.language || 'EN');
  const sup = opts.superPackage ? `<pak:superPackage adtcore:name="${esc(opts.superPackage.toUpperCase())}"/>` : '<pak:superPackage/>';
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:description="${esc(opts.description.slice(0, 60))}" adtcore:language="${lang}" adtcore:name="${name}" ` +
    `adtcore:type="DEVC/K" adtcore:version="active" adtcore:masterLanguage="${lang}">` +
    `<adtcore:packageRef adtcore:name="${name}"/>` +
    `<pak:attributes pak:packageType="${opts.packageType || 'development'}"/>` +
    sup +
    `<pak:applicationComponent/>` +
    `<pak:transport><pak:softwareComponent pak:name="${esc((opts.softwareComponent || 'HOME').toUpperCase())}"/>` +
    `<pak:transportLayer pak:name="${esc((opts.transportLayer || '').toUpperCase())}"/></pak:transport>` +
    `<pak:translation/><pak:useAccesses/><pak:packageInterfaces/><pak:subPackages/></pak:package>`;
}
