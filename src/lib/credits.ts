import { prisma } from './prisma';
import { FastifyReply } from 'fastify';

export async function deductCredits(
  userId: string,
  amount: number,
  type: string,
  description: string,
  reply: FastifyReply,
  paramsHash?: string,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { credits: true },
      });

      if (!user || user.credits < amount) {
        reply.code(402).send({ error: 'insufficient_credits', required: amount });
        // Throw to abort the transaction without updating anything
        throw new Error('INSUFFICIENT_CREDITS');
      }

      await tx.user.update({
        where: { id: userId },
        data: { credits: { decrement: amount } },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: -amount,
          type,
          description,
          paramsHash,
        },
      });
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
      return false;
    }
    throw err;
  }

  return true;
}

export async function addCredits(
  userId: string,
  amount: number,
  type: string,
  description: string,
  stripeSessionId?: string,
): Promise<void> {
  if (stripeSessionId) {
    const existing = await prisma.creditTransaction.findFirst({
      where: { stripeSessionId },
    });
    if (existing) return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { credits: { increment: amount } },
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        amount,
        type,
        description,
        stripeSessionId,
      },
    });
  });
}
