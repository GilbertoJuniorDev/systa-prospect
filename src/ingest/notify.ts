import type { IngestConfig } from './config';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface Mailer {
  sendMail(m: { from?: string; to: string; subject: string; html: string }): Promise<unknown>;
}

export interface Notifier {
  started(month: string): Promise<void>;
  succeeded(r: {
    month: string;
    durationMs: number;
    rowsByTable: Record<string, number>;
    recovered: boolean;
  }): Promise<void>;
  failed(r: {
    month: string;
    phase: string | null;
    error: string;
    kind: 'TEMPORARY' | 'PERMANENT';
    freeBytes: number | null;
  }): Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RETRY_TEMPORARY = 'Nova tentativa automática em 30 minutos.';
const RETRY_PERMANENT = 'Nova tentativa na próxima verificação diária ou via npm run ingest:now.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatGb(bytes: number): string {
  return (bytes / 1e9).toFixed(1).replace('.', ',');
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return h > 0 ? `${h}h ${min}min` : `${min}min`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function layout(title: string, body: string): string {
  return `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #fff; border-radius: 12px;">
        <h1 style="font-size: 20px; color: #3D2B1F; margin-bottom: 16px;">${escapeHtml(title)}</h1>
        ${body}
        <hr style="border: none; border-top: 1px solid #F0E8E3; margin: 24px 0;" />
        <p style="color: #C4B5AD; font-size: 12px;">Systa Prospect</p>
      </div>
    `;
}

function paragraph(text: string): string {
  return `<p style="color: #6B5B4E; font-size: 15px; line-height: 1.6;">${text}</p>`;
}

// ─── Notifier ────────────────────────────────────────────────────────────────

export function createNotifier(
  cfg: Pick<IngestConfig, 'notifyEmails'>,
  mailer: Mailer,
  log: (m: string) => void,
): Notifier {
  const recipients = [...cfg.notifyEmails];
  let warnedNoRecipients = false;

  async function send(subject: string, html: string): Promise<void> {
    if (recipients.length === 0) {
      if (!warnedNoRecipients) {
        warnedNoRecipients = true;
        log('INGEST_NOTIFY_EMAIL vazio: e-mails de atualização desativados');
      }
      return;
    }
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: recipients.join(', '),
        subject,
        html,
      });
    } catch (err) {
      log(`Falha ao enviar e-mail "${subject}": ${errorMessage(err)}`);
    }
  }

  return {
    async started(month) {
      const m = escapeHtml(month);
      await send(
        `[CNPJ] Atualização da base ${month} iniciada`,
        layout(
          `Atualização da base ${m} iniciada`,
          paragraph(
            `A atualização da base da Receita Federal (mês ${m}) foi iniciada. ` +
              'A API entrou em modo manutenção e as consultas retornarão indisponibilidade até o término da carga.',
          ),
        ),
      );
    },

    async succeeded(r) {
      const m = escapeHtml(r.month);
      const rows = Object.entries(r.rowsByTable)
        .map(
          ([table, count]) =>
            `<tr><td style="padding: 6px 12px; border-bottom: 1px solid #F0E8E3; color: #3D2B1F;">${escapeHtml(table)}</td>` +
            `<td style="padding: 6px 12px; border-bottom: 1px solid #F0E8E3; color: #3D2B1F; text-align: right;">${formatInt(count)}</td></tr>`,
        )
        .join('');
      const recovered = r.recovered
        ? paragraph('A API saiu da manutenção após falhas anteriores e voltou a atender normalmente.')
        : '';
      await send(
        `[CNPJ] Base ${r.month} atualizada com sucesso`,
        layout(
          `Base ${m} atualizada com sucesso`,
          paragraph(`Mês: <strong>${m}</strong><br />Duração: ${formatDuration(r.durationMs)}`) +
            recovered +
            `<table style="border-collapse: collapse; width: 100%; font-size: 14px;">
          <thead><tr>
            <th style="padding: 6px 12px; border-bottom: 1px solid #C4B5AD; text-align: left; color: #6B5B4E;">Tabela</th>
            <th style="padding: 6px 12px; border-bottom: 1px solid #C4B5AD; text-align: right; color: #6B5B4E;">Registros</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`,
        ),
      );
    },

    async failed(r) {
      const m = escapeHtml(r.month);
      const phase = r.phase === null ? '—' : escapeHtml(r.phase);
      const retry = r.kind === 'TEMPORARY' ? RETRY_TEMPORARY : RETRY_PERMANENT;
      const free = r.freeBytes === null ? 'desconhecido' : `${formatGb(r.freeBytes)} GB`;
      await send(
        `[CNPJ] Falha na atualização da base ${r.month}`,
        layout(
          `Falha na atualização da base ${m}`,
          paragraph(
            `Mês: <strong>${m}</strong><br />` +
              `Fase: ${phase}<br />` +
              `Espaço livre em disco: ${free}`,
          ) +
            `<p style="color: #3D2B1F; font-size: 14px; line-height: 1.5; white-space: pre-wrap; background: #FAF6F3; padding: 12px; border-radius: 8px;">${escapeHtml(r.error)}</p>` +
            paragraph(retry),
        ),
      );
    },
  };
}
