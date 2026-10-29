import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadIngestConfig } from './config';
import { tick, withFreshDb } from './scheduler';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function main(): Promise<number> {
  const forcedMonth = process.argv[2];
  if (forcedMonth !== undefined && !MONTH_RE.test(forcedMonth)) {
    console.error(`Mês inválido: "${forcedMonth}" (esperado AAAA-MM)`);
    return 1;
  }

  const cfg = loadIngestConfig(process.env);
  const prisma = new PrismaClient();
  try {
    const decision = await withFreshDb(cfg, prisma, (deps) => tick('manual', deps, forcedMonth));
    if (decision.kind === 'none') return 0;

    const run = await prisma.ingestRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { id: true, month: true, status: true },
    });
    console.log(`Run ${run?.id} (mês ${run?.month}): ${run?.status}`);
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
