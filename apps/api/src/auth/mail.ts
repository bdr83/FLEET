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
 * SMTP_URL   smtps://user:pass@smtp.example.com:465 (or smtp://…:587 for STARTTLS); user and pass URL-encoded
 * MAIL_FROM  "FLEET <no-reply@example.com>"
 */
export class SmtpMailSender implements MailSender {
  readonly configured = true;
  private readonly t: Transporter;
  constructor(url: string, private readonly from: string) {
    this.t = createTransport(url, { disableFileAccess: true, disableUrlAccess: true } as never);
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
  return env.NODE_ENV === 'production' ? new NoMailSender() : new LogMailSender();
}
