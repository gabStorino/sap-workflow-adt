import { BaseHandler } from '../../handlers/BaseHandler';

class Probe extends BaseHandler {
  getTools() { return []; }
  async handle() { return null; }
  run(name: string) { return this.postClassrun(name); }
  setDelays(d: number[]) { this.classrunDelays = d; }
}

function client(responses: Array<string | Error>) {
  const request = jest.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { body: next };
  });
  return {
    h: { request },
    logout: jest.fn(async () => undefined),
    login: jest.fn(async () => undefined),
    stateful: 'stateless',
  } as any;
}

describe('postClassrun', () => {
  const OLD = process.env.CLASSRUN_WAIT_MS;
  afterEach(() => { process.env.CLASSRUN_WAIT_MS = OLD; });

  it('retries while the class is not visible on the app server yet', async () => {
    const c = client(['Error: Class does not implement if_oo_adt_classrun~main method!',
                      'Error: Class does not implement if_oo_adt_classrun~main method!',
                      'hello']);
    const p = new Probe(c); p.setDelays([1, 1, 1]);
    await expect(p.run('ZCL_X')).resolves.toBe('hello');
    expect(c.h.request).toHaveBeenCalledTimes(3);
    expect(c.h.request.mock.calls[0][0]).toBe('/sap/bc/adt/oo/classrun/ZCL_X');
  });

  it('gives up after CLASSRUN_WAIT_MS and returns the error text', async () => {
    process.env.CLASSRUN_WAIT_MS = '0';
    const c = client(['Error: Class does not implement if_oo_adt_classrun~main method!']);
    const p = new Probe(c); p.setDelays([1]);
    await expect(p.run('ZCL_X')).resolves.toMatch(/does not implement/);
    expect(c.h.request).toHaveBeenCalledTimes(1);
  });

  it('retries once on a bare 400 with a fresh stateless session', async () => {
    const bare400 = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
    const c = client([bare400, 'ok']);
    const p = new Probe(c); p.setDelays([1]);
    await expect(p.run('ZCL_X')).resolves.toBe('ok');
    expect(c.logout).toHaveBeenCalledTimes(1);
    expect(c.login).toHaveBeenCalledTimes(1);
  });

  it('does not retry other errors', async () => {
    const e500 = Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
    const c = client([e500]);
    const p = new Probe(c);
    await expect(p.run('ZCL_X')).rejects.toThrow(/500/);
  });
});
