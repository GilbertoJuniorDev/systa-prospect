import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRY = Number(process.env.JWT_EXPIRY_SECONDS ?? 86400);

// Hash bcrypt válido (cost 12) usado por verifyPasswordSafe para gastar tempo
// equivalente ao de um login real quando o usuário não existe, evitando
// enumeração de contas por timing. PRECISA ser um hash válido — um hash
// malformado faz bcrypt.compare retornar rápido e anula a mitigação.
const DUMMY_HASH =
  '$2b$12$uVexoE5/NbCsNEcPMDe8mOunI40Z6HRPPqkFc6/XrrEmidxr5Y68u';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function verifyPasswordSafe(
  plain: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(payload: {
  userId: string;
  email: string;
}): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
    issuer: 'systa',
  });
}

export function verifyAccessToken(token: string): {
  userId: string;
  email: string;
} {
  const decoded = jwt.verify(token, JWT_SECRET, {
    issuer: 'systa',
    algorithms: ['HS256'],
  }) as {
    userId: string;
    email: string;
  };
  return { userId: decoded.userId, email: decoded.email };
}

export async function generateResetToken(): Promise<{
  raw: string;
  hash: string;
}> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(raw, 10);
  return { raw, hash };
}
