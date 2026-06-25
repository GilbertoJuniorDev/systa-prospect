import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma';
import {
  generateResetToken,
  hashPassword,
  signAccessToken,
  verifyPasswordSafe,
} from '../services/auth.service';
import { sendPasswordResetEmail } from '../services/email.service';
import {
  ForgotPasswordBody,
  LoginBody,
  ResetPasswordBody,
} from '../types/auth';
import bcrypt from 'bcrypt';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: LoginBody }>,
      reply: FastifyReply,
    ) => {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({ where: { email } });
      const isValid = await verifyPasswordSafe(
        password,
        user?.passwordHash ?? null,
      );

      if (!user || !isValid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const accessToken = signAccessToken({ userId: user.id, email: user.email });
      const expiresIn = Number(process.env.JWT_EXPIRY_SECONDS ?? 86400);

      return reply.send({ accessToken, expiresIn });
    },
  );

  app.post<{ Body: ForgotPasswordBody }>(
    '/forgot-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: ForgotPasswordBody }>,
      reply: FastifyReply,
    ) => {
      const { email } = request.body;
      const GENERIC_MSG = {
        message:
          'Se este e-mail está cadastrado, você receberá um link em breve.',
      };

      const user = await prisma.user.findUnique({ where: { email } });

      if (!user) {
        return reply.send(GENERIC_MSG);
      }

      await prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      const { raw, hash } = await generateResetToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: { tokenHash: hash, userId: user.id, expiresAt },
      });

      const resetUrl = `${process.env.APP_FRONTEND_URL}/reset-password?token=${raw}&email=${encodeURIComponent(email)}`;

      try {
        await sendPasswordResetEmail(email, resetUrl);
      } catch (err) {
        app.log.error({ err }, 'Failed to send password reset email');
      }

      return reply.send(GENERIC_MSG);
    },
  );

  app.post<{ Body: ResetPasswordBody }>(
    '/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'email', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
            newPassword: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: ResetPasswordBody }>,
      reply: FastifyReply,
    ) => {
      const { token, email, newPassword } = request.body;
      const INVALID_MSG = { error: 'Invalid or expired reset token' };

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return reply.code(400).send(INVALID_MSG);

      const candidates = await prisma.passwordResetToken.findMany({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      let matchedToken: (typeof candidates)[0] | null = null;
      for (const candidate of candidates) {
        const matches = await bcrypt.compare(token, candidate.tokenHash);
        if (matches) {
          matchedToken = candidate;
          break;
        }
      }

      if (!matchedToken) return reply.code(400).send(INVALID_MSG);

      const [passwordHash] = await Promise.all([
        hashPassword(newPassword),
        prisma.passwordResetToken.update({
          where: { id: matchedToken.id },
          data: { usedAt: new Date() },
        }),
      ]);

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      return reply.send({ message: 'Password updated' });
    },
  );
}
