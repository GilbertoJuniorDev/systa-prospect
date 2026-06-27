import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    transactionOptions: {
      timeout: 300_000, // 5 min — exports grandes (até MAX_EXPORT_ROWS=200k linhas)
      maxWait: 15_000, // espera por conexão do pool sob contenção
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
