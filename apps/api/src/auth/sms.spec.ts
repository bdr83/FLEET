import { HttpSmsSender, LogSmsSender, smsSenderFromEnv } from './sms';

describe('sms sender from env', () => {
  it('logs outside production, refuses log or nothing in production', () => {
    expect(smsSenderFromEnv({})).toBeInstanceOf(LogSmsSender);
    expect(() => smsSenderFromEnv({ NODE_ENV: 'production' })).toThrow(/must be set/);
    expect(() => smsSenderFromEnv({ NODE_ENV: 'production', SMS_PROVIDER: 'log' })).toThrow(/not allowed/);
  });
  it('http needs an https url and JSON objects', () => {
    expect(() => smsSenderFromEnv({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'http://x' })).toThrow(/https/);
    expect(() => smsSenderFromEnv({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://x', SMS_HTTP_HEADERS: '[1]' })).toThrow(/JSON object/);
    expect(smsSenderFromEnv({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://x', NODE_ENV: 'production' })).toBeInstanceOf(HttpSmsSender);
  });
  it('renders the template and posts it; a gateway error throws', async () => {
    const calls: [string, RequestInit][] = [];
    let status = 200;
    const f = (async (u: string, i: RequestInit) => { calls.push([u, i]); return { ok: status < 300, status } as Response; }) as unknown as typeof fetch;
    const s = new HttpSmsSender('https://gw/send', { authorization: 'Bearer k' }, { to: '{to}', p: '{to_plus}', msg: '{text}', sender: 'FLEET' }, false, f);
    await s.send('+96550001234', 'رمز الدخول: 123456');
    expect(calls[0][0]).toBe('https://gw/send');
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ to: '96550001234', p: '+96550001234', msg: 'رمز الدخول: 123456', sender: 'FLEET' });
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer k');
    const form = new HttpSmsSender('https://gw/send', {}, { to: '{to}', text: '{text}' }, true, f);
    await form.send('+96550001234', 'a b');
    expect(calls[1][1].body).toBe('to=96550001234&text=a+b');
    status = 500;
    await expect(s.send('+96550001234', 'x')).rejects.toThrow(/500/);
  });
});
