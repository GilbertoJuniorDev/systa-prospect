import { describe, it, expect, vi } from 'vitest';
import { createNotifier, type Mailer } from '../../src/ingest/notify';

function fakeMailer(impl?: () => Promise<unknown>) {
  const sent: Array<{ from?: string; to: string; subject: string; html: string }> = [];
  const mailer: Mailer = {
    sendMail: vi.fn(async (m) => {
      sent.push(m);
      return impl ? impl() : { messageId: '1' };
    }),
  };
  return { mailer, sent };
}

describe('createNotifier', () => {
  it('sends to all recipients joined', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com', 'b@y.com'] }, mailer, () => {});
    await n.started('2026-10');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('a@x.com, b@y.com');
    expect(sent[0].subject).toBe('[CNPJ] Atualização da base 2026-10 iniciada');
  });

  it('failure mentions 30 min for TEMPORARY', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.failed({ month: '2026-10', phase: 'download', error: 'timeout', kind: 'TEMPORARY', freeBytes: 12_300_000_000 });
    expect(sent[0].subject).toBe('[CNPJ] Falha na atualização da base 2026-10');
    expect(sent[0].html).toContain('Nova tentativa automática em 30 minutos.');
    expect(sent[0].html).toContain('12,3 GB');
  });

  it('failure mentions daily check for PERMANENT and unknown disk', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.failed({ month: '2026-10', phase: null, error: 'boom', kind: 'PERMANENT', freeBytes: null });
    expect(sent[0].html).toContain('Nova tentativa na próxima verificação diária ou via npm run ingest:now.');
    expect(sent[0].html).toContain('desconhecido');
    expect(sent[0].html).toContain('—');
  });

  it('escapes dynamic text inserted into html', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.failed({ month: '2026-10', phase: '<b>x</b>', error: `<script>alert("a&b's")</script>`, kind: 'PERMANENT', freeBytes: 1 });
    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).toContain('&lt;script&gt;alert(&quot;a&amp;b&#39;s&quot;)&lt;/script&gt;');
    expect(sent[0].html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('success e-mail formats duration, rows and recovery line', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.succeeded({
      month: '2026-10',
      durationMs: 2 * 3_600_000 + 15 * 60_000,
      rowsByTable: { Empresa: 1234567, Socio: 89 },
      recovered: true,
    });
    expect(sent[0].subject).toBe('[CNPJ] Base 2026-10 atualizada com sucesso');
    expect(sent[0].html).toContain('2h 15min');
    expect(sent[0].html).toContain('1.234.567');
    expect(sent[0].html).toContain('Socio');
    expect(sent[0].html).toContain('saiu da manutenção após falhas anteriores');
  });

  it('success e-mail shows minutes when under one hour and no recovery line otherwise', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.succeeded({ month: '2026-10', durationMs: 45 * 60_000, rowsByTable: {}, recovered: false });
    expect(sent[0].html).toContain('45min');
    expect(sent[0].html).not.toContain('saiu da manutenção');
  });

  it('started e-mail says the API entered maintenance mode', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    await n.started('2026-10');
    expect(sent[0].html).toContain('modo manutenção');
  });

  it('swallows mailer errors and logs them', async () => {
    const { mailer } = fakeMailer(async () => {
      throw new Error('smtp down');
    });
    const log = vi.fn();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, log);
    await expect(n.started('2026-10')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('smtp down'));
  });

  it('no recipients → no send', async () => {
    const { mailer } = fakeMailer();
    const log = vi.fn();
    const n = createNotifier({ notifyEmails: [] }, mailer, log);
    await n.started('2026-10');
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('no recipients → logs only once per notifier', async () => {
    const { mailer } = fakeMailer();
    const log = vi.fn();
    const n = createNotifier({ notifyEmails: [] }, mailer, log);
    await n.started('2026-10');
    await n.succeeded({ month: '2026-10', durationMs: 0, rowsByTable: {}, recovered: false });
    await n.failed({ month: '2026-10', phase: null, error: 'x', kind: 'PERMANENT', freeBytes: null });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reads SMTP_FROM at send time', async () => {
    const { mailer, sent } = fakeMailer();
    const n = createNotifier({ notifyEmails: ['a@x.com'] }, mailer, () => {});
    process.env.SMTP_FROM = 'Systa <no-reply@systa.local>';
    try {
      await n.started('2026-10');
    } finally {
      delete process.env.SMTP_FROM;
    }
    expect(sent[0].from).toBe('Systa <no-reply@systa.local>');
  });
});
