import bcrypt from 'bcrypt';
import * as readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main(): Promise<void> {
  console.log('\n=== Criação de Usuário — Systa Prospect ===\n');

  const email = await ask('E-mail: ');
  const name = await ask('Nome (opcional, Enter para pular): ');
  const password = await ask('Senha (mín. 8 caracteres): ');

  if (!email || !password) {
    console.error('\nErro: e-mail e senha são obrigatórios.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('\nErro: senha deve ter pelo menos 8 caracteres.');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`\nErro: já existe um usuário com o e-mail "${email}".`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: name.trim() || null,
    },
  });

  console.log(`\n✓ Usuário criado com sucesso!`);
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${user.email}`);
  if (user.name) console.log(`  Nome:  ${user.name}`);
}

main()
  .catch((err) => {
    console.error('\nErro inesperado:', err);
    process.exit(1);
  })
  .finally(async () => {
    rl.close();
    await prisma.$disconnect();
  });
