import { WorkflowHandlers, parseToolPayload } from '../../handlers/WorkflowHandlers';

/** Minimal ADTClient double: records HTTP requests made through adtclient.h.request. */
function fakeClient(opts: { getBody?: string; putFailsWith415Once?: boolean } = {}) {
  const calls: Array<{ url: string; config: any }> = [];
  let put415 = !!opts.putFailsWith415Once;
  const client: any = {
    h: {
      request: jest.fn(async (url: string, config: any) => {
        calls.push({ url, config });
        if (config?.method === 'PUT' && put415) {
          put415 = false;
          const e: any = new Error('Request failed with status code 415');
          e.response = { status: 415 };
          throw e;
        }
        if (config?.method === 'GET') return { body: opts.getBody ?? '' };
        return { body: '' };
      }),
    },
    lock: jest.fn(async () => ({ LOCK_HANDLE: 'LH1', CORRNR: 'S4HK900002', IS_LOCAL: '' })),
    unLock: jest.fn(async () => undefined),
  };
  return { client, calls };
}

const payload = (r: any) => parseToolPayload(r);

describe('package_create', () => {
  it('requires a transport for transportable packages', async () => {
    const { client } = fakeClient();
    const h = new WorkflowHandlers(client);
    await expect(h.validateAndHandle('package_create', { name: 'ZPKG', description: 'd' }))
      .rejects.toThrow(/transport is required/);
  });

  it('POSTs a v2 package document with corrNr', async () => {
    const { client, calls } = fakeClient();
    const h = new WorkflowHandlers(client);
    const r = await h.validateAndHandle('package_create', { name: 'zpkg', description: 'd', transport: 's4hk900001' });
    expect(payload(r).name).toBe('ZPKG');
    expect(calls[0].url).toBe('/sap/bc/adt/packages');
    expect(calls[0].config.method).toBe('POST');
    expect(calls[0].config.headers['Content-Type']).toBe('application/vnd.sap.adt.packages.v2+xml');
    expect(calls[0].config.qs.corrNr).toBe('S4HK900001');
    expect(calls[0].config.body).toContain('adtcore:name="ZPKG"');
  });

  it('local $ packages need no transport and use LOCAL software component', async () => {
    const { client, calls } = fakeClient();
    const h = new WorkflowHandlers(client);
    await h.validateAndHandle('package_create', { name: '$ztest', description: 'd' });
    expect(calls[0].config.body).toContain('pak:softwareComponent pak:name="LOCAL"');
    expect(calls[0].config.qs.corrNr).toBeUndefined();
  });
});

describe('msag_set_messages', () => {
  const existing = `<mc:messageClass adtcore:name="ZWF_ZIP" adtcore:description="Msgs" adtcore:masterLanguage="EN" ` +
    `xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:packageRef adtcore:name="ZWF_ZIP"/>` +
    `<mc:messages mc:msgno="000" mc:msgtext="&amp;1&amp;2" mc:selfexplainatory="true"/></mc:messageClass>`;

  it('merges, locks, PUTs with lockHandle + corrNr from the lock, then unlocks', async () => {
    const { client, calls } = fakeClient({ getBody: existing });
    const h = new WorkflowHandlers(client);
    const r = await h.validateAndHandle('msag_set_messages', {
      name: 'zwf_zip', messages: [{ number: '1', text: 'ZIP &1 not found' }],
    });
    const p = payload(r);
    expect(p.messages.map((m: any) => m.number)).toEqual(['000', '001']);
    const put = calls.find(c => c.config.method === 'PUT')!;
    expect(put.url).toBe('/sap/bc/adt/messageclass/zwf_zip');
    expect(put.config.qs).toEqual({ lockHandle: 'LH1', corrNr: 'S4HK900002' });
    expect(put.config.body).toContain('mc:msgno="001" mc:msgtext="ZIP &amp;1 not found"');
    expect(put.config.body).toContain('<adtcore:packageRef adtcore:name="ZWF_ZIP"/>');
    expect(client.unLock).toHaveBeenCalledWith('/sap/bc/adt/messageclass/zwf_zip', 'LH1');
  });

  it('replace mode drops messages not in the list', async () => {
    const { client, calls } = fakeClient({ getBody: existing });
    const h = new WorkflowHandlers(client);
    await h.validateAndHandle('msag_set_messages', {
      name: 'ZWF_ZIP', mode: 'replace', messages: [{ number: '005', text: 'only' }],
    });
    const put = calls.find(c => c.config.method === 'PUT')!;
    expect(put.config.body).not.toContain('mc:msgno="000"');
    expect(put.config.body).toContain('mc:msgno="005"');
  });

  it('falls back to application/xml when the vendor media type is rejected (415)', async () => {
    const { client, calls } = fakeClient({ getBody: existing, putFailsWith415Once: true });
    const h = new WorkflowHandlers(client);
    await h.validateAndHandle('msag_set_messages', { name: 'ZWF_ZIP', messages: [{ number: '1', text: 'x' }] });
    const puts = calls.filter(c => c.config.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1].config.headers['Content-Type']).toMatch(/^application\/xml/);
  });

  it('accepts messages as a JSON string and rejects invalid numbers', async () => {
    const { client } = fakeClient({ getBody: existing });
    const h = new WorkflowHandlers(client);
    await expect(h.validateAndHandle('msag_set_messages', { name: 'ZWF_ZIP', messages: '[{"number":"abc","text":"x"}]' }))
      .rejects.toThrow(/invalid messages/);
    const ok = await h.validateAndHandle('msag_set_messages', { name: 'ZWF_ZIP', messages: '[{"number":"2","text":"x"}]' });
    expect(payload(ok).status).toBe('success');
  });

  it('unlocks when the PUT fails', async () => {
    const { client } = fakeClient({ getBody: existing });
    client.h.request = jest.fn(async (_url: string, config: any) => {
      if (config.method === 'GET') return { body: existing };
      throw Object.assign(new Error('boom'), { response: { status: 500 } });
    });
    const h = new WorkflowHandlers(client);
    await expect(h.validateAndHandle('msag_set_messages', { name: 'ZWF_ZIP', messages: [{ number: '1', text: 'x' }] }))
      .rejects.toThrow();
    expect(client.unLock).toHaveBeenCalled();
  });
});

describe('wf_class_scaffold preview', () => {
  it('returns names and all sources without touching SAP', async () => {
    const { client, calls } = fakeClient();
    const h = new WorkflowHandlers(client);
    const r = await h.validateAndHandle('wf_class_scaffold', { className: 'ZCL_WF_ZIP', description: 'ZIP' });
    const p = payload(r);
    expect(p.mode).toBe('preview');
    expect(Object.keys(p.sources)).toEqual(expect.arrayContaining(['ZCL_WF_ZIP', 'ZCX_WF_ZIP_ERROR', 'ZCX_WF_ZIP_TEMP']));
    expect(calls).toHaveLength(0);
  });

  it('deploy requires package and transport', async () => {
    const { client } = fakeClient();
    const h = new WorkflowHandlers(client);
    await expect(h.validateAndHandle('wf_class_scaffold', { className: 'ZCL_WF_ZIP', description: 'x', mode: 'deploy' }))
      .rejects.toThrow(/package is required/);
    await expect(h.validateAndHandle('wf_class_scaffold', { className: 'ZCL_WF_ZIP', description: 'x', mode: 'deploy', package: 'ZPKG' }))
      .rejects.toThrow(/transport REQUEST is required/);
  });
});
