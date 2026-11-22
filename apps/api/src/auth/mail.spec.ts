import { LogMailSender, mailSenderFromEnv, NoMailSender, SmtpMailSender } from './mail';

describe('mailSenderFromEnv', () => {
  it('uses SMTP from host/user/pass with plain passwords', () => {
    const m = mailSenderFromEnv({ NODE_ENV: 'production', SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'no-reply@q8hub.com', SMTP_PASS: 'p@ss:w/rd' });
    expect(m).toBeInstanceOf(SmtpMailSender);
    expect(m.configured).toBe(true);
  });
  it('accepts SMTP_URL but needs MAIL_FROM with it', () => {
    expect(() => mailSenderFromEnv({ SMTP_URL: 'smtps://a:b@h:465' })).toThrow(/MAIL_FROM/);
    expect(() => mailSenderFromEnv({ SMTP_URL: 'http://x' })).toThrow(/smtp/);
    expect(mailSenderFromEnv({ SMTP_URL: 'smtps://a:b@h:465', MAIL_FROM: 'x@y.z' })).toBeInstanceOf(SmtpMailSender);
  });
  it('without SMTP: unconfigured in production, a logger in dev', () => {
    const p = mailSenderFromEnv({ NODE_ENV: 'production', SMTP_HOST: 'h' });
    expect(p).toBeInstanceOf(NoMailSender);
    expect(p.configured).toBe(false);
    expect(mailSenderFromEnv({})).toBeInstanceOf(LogMailSender);
  });
});
