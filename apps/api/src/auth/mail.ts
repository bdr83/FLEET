import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export const MAIL_SENDER = 'MAIL_SENDER';
export interface MailSender { readonly configured: boolean; send(to: string, subject: string, text: string): Promise<void> }

/** Dev/test: logs a masked address, never the content. */
export class LogMailSender implements MailSender {
  readonly configured = true;
  private readonly log = new Logger('mail');
  async send(to: string) { this.log.log(`mail sent to ${to.slice(0, 2)}***@${to.split('@')[1] ?? ''}`); }
}

/** Production without SMTP: password login works, but nothing can be emailed (reset answers 503). */
export class NoMailSender implements MailSender {
  readonly configured = false;
  async send(): Promise<void> { throw new Error('mail not configured'); }
}

/**
 * Either SMTP_URL  smtps://user:pass@smtp.example.com:465 (user and pass URL-encoded)
 * or     SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS; default 465), SMTP_USER, SMTP_PASS (plain, no encoding).
 * MAIL_FROM "FLEET <no-reply@example.com>"; defaults to SMTP_USER.
 */
export class SmtpMailSender implements MailSender {
  readonly configured = true;
  private readonly t: Transporter;
  constructor(transport: string | { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }, private readonly from: string) {
    this.t = typeof transport === 'string'
      ? createTransport(transport, { disableFileAccess: true, disableUrlAccess: true } as never)
      : createTransport({ ...transport, disableFileAccess: true, disableUrlAccess: true } as never);
  }
  async send(to: string, subject: string, text: string) {
    await this.t.sendMail({ from: this.from, to, subject, text });
  }
}

export function mailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): MailSender {
  const url = env.SMTP_URL;
  if (url) {
    if (!/^smtps?:\/\//.test(url)) throw new Error('SMTP_URL must start with smtp:// or smtps://');
    if (!env.MAIL_FROM) throw new Error('MAIL_FROM is required with SMTP_URL');
    return new SmtpMailSender(url, env.MAIL_FROM);
  }
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    const port = Number(env.SMTP_PORT || 465);
    if (!Number.isInteger(port) || port <= 0) throw new Error('SMTP_PORT must be a port number');
    return new SmtpMailSender({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } },
      env.MAIL_FROM || env.SMTP_USER);
  }
  return env.NODE_ENV === 'production' ? new NoMailSender() : new LogMailSender();
}
