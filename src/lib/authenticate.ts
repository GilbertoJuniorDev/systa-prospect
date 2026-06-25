import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../services/auth.service';

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    request.user = verifyAccessToken(token);
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}
