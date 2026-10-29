import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadIngestConfig } from './config';
import { tick, withFreshDb } from './scheduler';

/**
 * Uso: `npm run ingest:now` (mesma decisão do ciclo diário) ou
 * `npm run ingest:now -- AAAA-MM` (força um mês). Atenção: forçar um mês mais
 * antigo que o mais novo publicado é temporário — o próximo ciclo diário do
 * agendador vê o mês mais novo no servidor e o carrega por cima.
 */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function main(): Promise<number> {
  const forcedMonth = process.argv[2];
  if (forcedMonth !== undefined && !MONTH_RE.test(forcedMonth)) {
    console.error(`Mês inválido: "${forcedMonth}" (esperado AAAA-MM)`);
    return 1;
  }

  const cfg = loadIngestConfig(process.env);
  if (forcedMonth !== undefined) {
    console.log(
      `Forçando o mês ${forcedMonth}. Se houver mês mais novo no servidor, ` +
        'o próximo ciclo diário do agendador vai substituí-lo.',
    );
  }
  const prisma = new PrismaClient();
  try {
    const { decision, runId } = await withFreshDb(cfg, prisma, (deps) =>
      tick('manual', deps, forcedMonth),
    );
    if (decision.kind === 'none' || !runId) {
      if (decision.kind === 'none') console.error(`Nada a fazer: ${decision.reason}`);
      return 0;
    }

    const run = await prisma.ingestRun.findUnique({
      where: { id: runId },
      select: { id: true, month: true, status: true },
    });
    console.log(`Run ${runId} (mês ${run?.month}): ${run?.status}`);
    return run?.status === 'SUCCESS' ? 0 : 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Falha:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
