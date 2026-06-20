# CNPJ ETL — Pipeline de Ingestão e Consulta (Node.js + PostgreSQL)

Serviço isolado (standalone) para processamento e consulta dos dados públicos da Receita Federal, construído sobre o ecossistema TypeScript, Node.js e PostgreSQL via Prisma. Otimizado para lidar com arquivos gigantes sem estourar a memória.

---

## Fase 1 — Preparação da Infraestrutura e Ambiente

### Subir o Banco de Dados

Inicie uma instância dedicada do PostgreSQL via Docker.

> **Dica de tuning:** Configure o Postgres temporariamente para ingestão massiva — aumente o `max_wal_size` e diminua o `checkpoint_timeout`.

### Inicializar o Projeto Node.js

```bash
mkdir cnpj-etl && cd cnpj-etl
npm init -y
tsc --init
```

### Instalar Dependências

```bash
npm i @prisma/client csv-parser iconv-lite
npm i -D prisma typescript @types/node ts-node
```

| Pacote | Motivo |
|---|---|
| `csv-parser` | Extremamente rápido com Streams |
| `iconv-lite` | Converte ISO-8859-1 (padrão da Receita) para UTF-8 |

---

## Fase 2 — Modelagem no Prisma

O arquivo `.EMPRECSV` não tem cabeçalho — mapeie as posições com base no layout oficial da Receita.

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Empresa {
  cnpj_base         String  @id @db.VarChar(8)
  razao_social      String
  natureza_juridica String  @db.VarChar(4)
  qualificacao_resp String  @db.VarChar(2)
  capital_social    Float
  porte             String  @db.VarChar(2)
  ente_federativo   String?

  @@index([razao_social]) // Essencial para buscas textuais
}
```

> **Atenção:** Não crie os índices textuais **antes** da importação. Importe os dados para uma tabela limpa e crie os índices via SQL direto no banco após a finalização do script.

---

## Fase 3 — Processamento de Múltiplos Arquivos da Pasta `temp/`

Os dados da Receita Federal são distribuídos em **vários arquivos separados** (ex.: `EMPRECSV`, `ESTABELECIMENTO`, `SOCIOS`, etc.). O script deve descobrir e processar todos automaticamente, em sequência, sem intervenção manual.

### Estrutura esperada da pasta

```
temp/
├── K3241.K03200Y0.D30513.EMPRECSV
├── K3241.K03200Y1.D30513.EMPRECSV
├── K3241.K03200Y2.D30513.EMPRECSV
└── ...
```

### Script de orquestração (`src/ingest.ts`)

```typescript
import fs from 'fs';
import path from 'path';

const TEMP_DIR = path.resolve('./temp');

// Filtra apenas arquivos .EMPRECSV (ajuste a extensão conforme o tipo de dado)
function listarArquivos(dir: string, extensao: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(extensao))
    .map((f) => path.join(dir, f))
    .sort(); // Ordena para garantir ordem determinística
}

async function main() {
  const arquivos = listarArquivos(TEMP_DIR, '.EMPRECSV');

  if (arquivos.length === 0) {
    console.log('Nenhum arquivo encontrado na pasta temp/.');
    return;
  }

  console.log(`🔍 ${arquivos.length} arquivo(s) encontrado(s). Iniciando ingestão...`);

  for (let i = 0; i < arquivos.length; i++) {
    const arquivo = arquivos[i];
    console.log(`\n📄 [${i + 1}/${arquivos.length}] Processando: ${path.basename(arquivo)}`);

    await processarArquivo(arquivo); // função da Fase 3.1 abaixo

    console.log(`✅ Concluído: ${path.basename(arquivo)}`);
  }

  console.log('\n🎉 Todos os arquivos foram processados com sucesso!');
}

main().catch(console.error);
```

> **Por que sequencial e não paralelo?** Processar um arquivo por vez evita sobrecarga de memória e contenção de conexões no banco. Com arquivos de vários GBs cada, paralelismo aqui prejudica mais do que ajuda.

### Rastreamento de progresso (opcional, mas recomendado)

Para poder **retomar de onde parou** caso o script caia, salve o nome de cada arquivo concluído em um arquivo de controle:

```typescript
const PROGRESSO_FILE = path.resolve('./temp/.progresso.json');

function carregarProgresso(): Set<string> {
  if (!fs.existsSync(PROGRESSO_FILE)) return new Set();
  const dados = JSON.parse(fs.readFileSync(PROGRESSO_FILE, 'utf-8'));
  return new Set(dados);
}

function salvarProgresso(concluidos: Set<string>) {
  fs.writeFileSync(PROGRESSO_FILE, JSON.stringify([...concluidos]), 'utf-8');
}

// No loop principal, pule arquivos já processados:
const concluidos = carregarProgresso();

for (const arquivo of arquivos) {
  const nome = path.basename(arquivo);

  if (concluidos.has(nome)) {
    console.log(`⏭️  Pulando (já processado): ${nome}`);
    continue;
  }

  await processarArquivo(arquivo);

  concluidos.add(nome);
  salvarProgresso(concluidos);
}
```

---

## Fase 3.1 — Pipeline de Extração por Arquivo (Streams)

A função `processarArquivo(caminho)` encapsula toda a lógica de leitura para um único arquivo.

### Configurar os Streams

```typescript
import csvParser from 'csv-parser';
import iconv from 'iconv-lite';

function processarArquivo(caminho: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let batch: object[] = [];

    const stream = fs.createReadStream(caminho)
      .pipe(iconv.decodeStream('win1252'))  // Converte encoding da Receita
      .pipe(csvParser({ separator: ';', headers: false }));

    stream.on('data', async (row) => { /* ... lógica de batching abaixo */ });
    stream.on('end',  resolve);
    stream.on('error', reject);
  });
}
```

### Lógica de Batching (Lotes)

- Crie um array vazio: `let batch = []`.
- No evento `.on('data')`, empurre a linha formatada para esse array.
- Quando `batch.length` chegar a um limite (ex.: `10000`), pause a leitura com `stream.pause()`.

### Transformação de Dados (Parsing)

- Mapeie os índices numéricos gerados pelo `csv-parser` para os campos do banco:
  - `cnpj_base: row[0]`
  - `razao_social: row[1]`
  - etc.
- Trate o capital social substituindo a vírgula por ponto antes de converter para `Float`.

---

## Fase 4 — Motor de Inserção (Load)

### Inserção em Lote

```typescript
await prisma.empresa.createMany({
  data: batch,
  skipDuplicates: true, // Permite reexecutar o script sem quebrar em chaves duplicadas
});
```

### Limpar e Retomar

Após a promessa resolver com sucesso:

```typescript
batch = [];
stream.resume();
```

### Tática Avançada (Opcional, mas recomendada)

Se o `createMany` estiver lento para dezenas de milhões de linhas, utilize o comando nativo do Postgres:

```typescript
await prisma.$executeRawUnsafe(
  `COPY empresas FROM '/caminho/temp.csv' DELIMITER ';' CSV;`
);
```

O Postgres ingere milhões de linhas em segundos com `COPY`.

---

## Fase 5 — API de Consulta

Com o banco alimentado, suba um servidor HTTP com **Fastify** ou **Express** integrado ao Prisma Client.

### Rotas Essenciais

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/empresas/:cnpj_base` | Busca exata por CNPJ (Primary Key — velocidade máxima) |
| `GET` | `/empresas/buscar?nome=TERMO` | Busca por Razão Social |

> **Dica para busca textual:** Use `ILIKE` com um índice GIN via extensão `pg_trgm` no Postgres para evitar buscas que levem minutos.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_razao_social_trgm ON "Empresa" USING gin (razao_social gin_trgm_ops);
```

---

## Resultado

Uma base de dados local completa da Receita Federal, acessível em milissegundos, pronta para ser consumida por qualquer ferramenta, dashboard ou aplicação que você queira conectar.