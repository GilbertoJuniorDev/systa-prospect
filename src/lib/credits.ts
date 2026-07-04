import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { FastifyReply } from 'fastify';

export async function deductCredits(
  userId: string,
  amount: number,
  type: string,
  description: string,
  reply: FastifyReply,
  paramsHash?: string,
): Promise<number | null> {
  try {
    // Atomic conditional UPDATE: only decrements if balance >= amount.
    // Avoids the read-check-write race condition that could produce negative balances
    // when two concurrent requests both read the same balance before either writes.
    const updated = await prisma.$queryRaw<{ credits: number }[]>`
      UPDATE "User"
      SET credits = credits - ${amount}
      WHERE id = ${userId} AND credits >= ${amount}
      RETURNING credits
    `;

    if (updated.length === 0) {
      reply.code(402).send({ error: 'insufficient_credits', required: amount });
      return null;
    }

    await prisma.creditTransaction.create({
      data: {
        userId,
        amount: -amount,
        type,
        description,
        paramsHash,
      },
    });

    return updated[0].credits;
  } catch (err: unknown) {
    throw err;
  }
}

export async function addCredits(
  userId: string,
  amount: number,
  type: string,
  description: string,
  stripeSessionId?: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // Idempotency check inside the transaction prevents TOCTOU: two concurrent
      // webhook retries could both pass an external findFirst before either inserts.
      if (stripeSessionId) {
        const existing = await tx.creditTransaction.findFirst({
          where: { stripeSessionId },
        });
        if (existing) return;
      }

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
  } catch (err: unknown) {
    // P2002 = unique constraint violation on stripeSessionId — already processed, safe to ignore.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return;
    }
    throw err;
  }
}
