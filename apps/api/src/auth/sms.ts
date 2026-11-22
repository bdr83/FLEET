import { Logger } from '@nestjs/common';
import type { SmsSender } from './otp.service';

/** Dev/test sender: logs a masked phone, never the code. */
export class LogSmsSender implements SmsSender {
  private readonly log = new Logger('sms');
  async send(phone: string, _text: string) { this.log.log(`OTP sent to ${phone.slice(0, 6)}****`); }
}

/**
 * Generic HTTP gateway, for an SMS provider chosen later (decision C5). Most gateways take one POST per message:
 *   SMS_HTTP_URL       https://gateway.example/send
 *   SMS_HTTP_HEADERS   JSON object of headers, e.g. {"authorization":"Bearer …"}
 *   SMS_HTTP_BODY      JSON template; "{to}" (E.164 without +), "{to_plus}" and "{text}" are replaced, e.g. {"to":"{to}","message":"{text}","sender":"FLEET"}
 *   SMS_HTTP_FORM=1    send the body as application/x-www-form-urlencoded instead of JSON
 * A non-2xx answer throws, so the login request fails visibly instead of silently sending nothing.
 */
export class HttpSmsSender implements SmsSender {
  private readonly log = new Logger('sms');
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly body: Record<string, unknown>,
    private readonly form: boolean,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpSmsSender {
    const url = env.SMS_HTTP_URL;
    if (!url || !/^https:\/\//.test(url)) throw new Error('SMS_HTTP_URL must be an https URL');
    const json = (name: string, v: string | undefined, d: object) => {
      if (!v) return d;
      try { const o = JSON.parse(v); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* fall through */ }
      throw new Error(`${name} must be a JSON object`);
    };
    return new HttpSmsSender(url, json('SMS_HTTP_HEADERS', env.SMS_HTTP_HEADERS, {}) as Record<string, string>,
      json('SMS_HTTP_BODY', env.SMS_HTTP_BODY, { to: '{to}', text: '{text}' }) as Record<string, unknown>, env.SMS_HTTP_FORM === '1');
  }

  render(phone: string, text: string): Record<string, string> {
    const to = phone.replace(/^\+/, '');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.body)) {
      out[k] = String(v).replaceAll('{to_plus}', `+${to}`).replaceAll('{to}', to).replaceAll('{text}', text);
    }
    return out;
  }

  async send(phone: string, text: string) {
    const b = this.render(phone, text);
    const r = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': this.form ? 'application/x-www-form-urlencoded' : 'application/json', ...this.headers },
      body: this.form ? new URLSearchParams(b).toString() : JSON.stringify(b),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      this.log.error(`gateway answered ${r.status} for ${phone.slice(0, 6)}****`);
      throw new Error(`sms gateway ${r.status}`);
    }
  }
}

/** SMS_PROVIDER: "log" (default outside production) or "http". Production refuses "log" so logins are never silently broken. */
export function smsSenderFromEnv(env: NodeJS.ProcessEnv = process.env): SmsSender {
  const p = env.SMS_PROVIDER ?? (env.NODE_ENV === 'production' ? '' : 'log');
  if (p === 'http') return HttpSmsSender.fromEnv(env);
  if (p === 'log') {
    if (env.NODE_ENV === 'production') throw new Error('SMS_PROVIDER=log is not allowed in production');
    return new LogSmsSender();
  }
  throw new Error('SMS_PROVIDER must be set (http) in production');
}
