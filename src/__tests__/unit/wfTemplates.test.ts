import {
  deriveWfNames,
  defaultRelid,
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
} from '../../lib/wfTemplates';

describe('deriveWfNames', () => {
  it('derives all names from ZCL_ class names', () => {
    const n = deriveWfNames({ className: 'zcl_wf_zip', description: 'x' });
    expect(n.className).toBe('ZCL_WF_ZIP');
    expect(n.errorClass).toBe('ZCX_WF_ZIP_ERROR');
    expect(n.tempClass).toBe('ZCX_WF_ZIP_TEMP');
    expect(n.messageClass).toBe('ZWF_ZIP');
    expect(n.clusterTable).toBe('ZWF_XML_INDX');
    expect(n.keyField).toBe('OBJECT_ID');
    expect(n.relid).toMatch(/^Z[A-Z0-9]$/);
  });

  it('keeps the Y namespace', () => {
    const n = deriveWfNames({ className: 'YCL_ORDER', description: 'x' });
    expect(n.errorClass).toBe('YCX_ORDER_ERROR');
    expect(n.messageClass).toBe('YORDER');
    expect(n.clusterTable).toBe('YWF_XML_INDX');
  });

  it('applies overrides', () => {
    const n = deriveWfNames({
      className: 'ZCL_A', description: 'x', errorClass: 'zcx_e', tempClass: 'zcx_t',
      messageClass: 'zmsg', clusterTable: 'zindx', relid: 'q1', keyField: 'doc_id',
    });
    expect(n).toMatchObject({ errorClass: 'ZCX_E', tempClass: 'ZCX_T', messageClass: 'ZMSG',
      clusterTable: 'ZINDX', relid: 'Q1', keyField: 'DOC_ID' });
  });

  it('rejects names outside the customer namespace', () => {
    expect(() => deriveWfNames({ className: 'CL_WF_ZIP', description: 'x' })).toThrow(/Z or Y/);
  });

  it('rejects derived names that exceed SAP limits', () => {
    expect(() => deriveWfNames({ className: 'ZCL_AN_EXTREMELY_LONG_NAME_XX', description: 'x' }))
      .toThrow(/longer than/);
  });

  it('rejects bad relid and keyField', () => {
    expect(() => deriveWfNames({ className: 'ZCL_A', description: 'x', relid: 'ABC' })).toThrow(/relid/);
    expect(() => deriveWfNames({ className: 'ZCL_A', description: 'x', keyField: '1BAD' })).toThrow(/keyField/);
  });

  it('defaultRelid is stable', () => {
    expect(defaultRelid('ZCL_WF_ZIP')).toBe(defaultRelid('zcl_wf_zip'));
  });
});

describe('generated ABAP sources', () => {
  const input = { className: 'ZCL_WF_DEMO', description: 'Demo' };
  const names = deriveWfNames(input);
  const cls = buildWfClassSource(input, names);

  it('class implements IF_WORKFLOW with private instantiation', () => {
    expect(cls).toMatch(/CLASS zcl_wf_demo DEFINITION\s+PUBLIC\s+FINAL\s+CREATE PRIVATE/);
    expect(cls).toContain('INTERFACES if_workflow.');
    expect(cls).toContain('METHOD bi_persistent~find_by_lpor.');
    expect(cls).toContain('METHOD bi_object~release.');
    expect(cls).toContain(`c_relid TYPE indx_relid VALUE '${names.relid}'`);
  });

  it('never uses a method call as data cluster ID (ABAP syntax error)', () => {
    expect(cls).not.toMatch(/ID\s+cluster_id\(/);
    expect(cls).toMatch(/ID lv_cid\./);
  });

  it('has no "*" comment lines between methods (rejected by source-based editor)', () => {
    const impl = cls.slice(cls.indexOf('IMPLEMENTATION.'));
    const outside = impl.split(/METHOD [\s\S]*?ENDMETHOD\./).join('');
    expect(outside).not.toMatch(/^\*/m);
  });

  it('exceptions inherit CX_BO_ERROR / CX_BO_TEMPORARY with T100 texts', () => {
    const err = buildWfExceptionSource(names.errorClass, 'error', names);
    const tmp = buildWfExceptionSource(names.tempClass, 'temporary', names);
    expect(err).toContain('INHERITING FROM cx_bo_error');
    expect(err).toContain("msgid TYPE symsgid VALUE 'ZWF_DEMO'");
    expect(err).toContain('END OF not_found');
    expect(tmp).toContain('INHERITING FROM cx_bo_temporary');
    expect(tmp).toContain('END OF locked');
  });

  it('test include references the class and error exception', () => {
    const t = buildWfTestSource(names);
    expect(t).toContain('FOR TESTING');
    expect(t).toContain('zcl_wf_demo=>create( )');
    expect(t).toContain('CATCH zcx_wf_demo_error');
  });

  it('cluster table is an INDX copy', () => {
    const t = buildClusterTableSource('ZWF_XML_INDX');
    expect(t).toContain('define table zwf_xml_indx');
    expect(t).toContain('key srtfd : indx_srtfd not null;');
    expect(t).toContain('clustd    : indx_clust;');
  });

  it('default messages cover the numbers the exceptions use', () => {
    const nums = wfDefaultMessages().map(m => m.number);
    expect(nums).toEqual(['000', '001', '002', '003']);
  });
});

describe('message class XML', () => {
  const sample = `<?xml version="1.0" encoding="utf-8"?><mc:messageClass adtcore:masterLanguage="EN" adtcore:name="ZBC610" ` +
    `adtcore:description="Power &amp; more" xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/zbc610_02" adtcore:type="DEVC/K" adtcore:name="ZBC610_02"/>` +
    `<mc:messages mc:msgno="000" mc:msgtext="Power value too high" mc:selfexplainatory="true" mc:documented="false" adtcore:name=""><atom:link href="x"/></mc:messages>` +
    `<mc:messages mc:msgno="001" mc:msgtext="Value &amp;1 &lt;wrong&gt;" mc:selfexplainatory="false" adtcore:name=""/>` +
    `</mc:messageClass>`;

  it('parses header and messages', () => {
    const p = parseMessageClassXml(sample);
    expect(p.description).toBe('Power & more');
    expect(p.packageName).toBe('ZBC610_02');
    expect(p.masterLanguage).toBe('EN');
    expect(p.messages).toEqual([
      { number: '000', text: 'Power value too high', selfExplanatory: true },
      { number: '001', text: 'Value &1 <wrong>', selfExplanatory: false },
    ]);
  });

  it('builds escaped, sorted XML that round-trips', () => {
    const xml = buildMessageClassXml({
      name: 'zwf_zip', description: 'Msgs', messages: [
        { number: '2', text: 'B "quoted" & <x>' }, { number: '001', text: 'A &1' },
      ],
    });
    expect(xml).toContain('adtcore:name="ZWF_ZIP"');
    expect(xml.indexOf('mc:msgno="001"')).toBeLessThan(xml.indexOf('mc:msgno="002"'));
    const back = parseMessageClassXml(xml);
    expect(back.messages.map(m => m.text)).toEqual(['A &1', 'B "quoted" & <x>']);
  });

  it('merge: incoming replaces by number, keeps the rest', () => {
    const merged = mergeMessages(
      [{ number: '000', text: 'old0' }, { number: '001', text: 'old1' }],
      [{ number: '1', text: 'new1' }, { number: '005', text: 'new5' }]
    );
    expect(merged.map(m => `${m.number}:${m.text}`)).toEqual(['000:old0', '001:new1', '005:new5']);
  });

  it('rejects texts over 73 chars and bad numbers', () => {
    expect(() => mergeMessages([], [{ number: '1', text: 'x'.repeat(74) }])).toThrow(/73/);
    expect(() => normalizeMsgNo('1000')).toThrow();
    expect(() => normalizeMsgNo('ab')).toThrow();
    expect(normalizeMsgNo(7)).toBe('007');
  });
});

describe('package XML', () => {
  it('builds a v2 package document with software component', () => {
    const xml = buildPackageXml({ name: 'zwf_zip', description: 'Workflow ZIP' });
    expect(xml).toContain('adtcore:name="ZWF_ZIP"');
    expect(xml).toContain('pak:packageType="development"');
    expect(xml).toContain('<pak:softwareComponent pak:name="HOME"/>');
    expect(xml).toContain('<pak:superPackage/>');
  });

  it('sets the super package for sub-packages and truncates the description', () => {
    const xml = buildPackageXml({ name: 'zsub', description: 'd'.repeat(80), superPackage: 'zmain', transportLayer: 'zs4h' });
    expect(xml).toContain('<pak:superPackage adtcore:name="ZMAIN"/>');
    expect(xml).toContain('<pak:transportLayer pak:name="ZS4H"/>');
    expect(xml).toContain(`adtcore:description="${'d'.repeat(60)}"`);
  });
});
