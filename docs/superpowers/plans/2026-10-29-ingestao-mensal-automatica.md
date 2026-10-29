# Ingestão Mensal Automática — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serviço `ingest` de longa duração que detecta mês novo no WebDAV da Receita, coloca a API em manutenção, recarrega a base do zero com retomada e controle de disco, avisa por e-mail; API ganha modo manutenção, `/base/status`, aviso de cache defasado e cobrança da diferença na reexportação.

**Architecture:** Novo módulo `src/ingest/` com peças puras (decisão, agenda, disco, PROPFIND, preço) testadas isoladamente e um orquestrador (`run.ts`) que recebe dependências injetadas. Estado da ingestão vive no Postgres (`IngestRun`, `IngestFile`); a API lê esse estado (cache 30 s) para decidir manutenção. `src/download.ts` e `src/ingest.ts` antigos são substituídos.

**Tech Stack:** TypeScript 5, Node 20 (container) / 22 (dev), Fastify 5, Prisma 5, `pg` + `pg-copy-streams`, `unzipper`, `nodemailer`, Vitest (nova dev-dependency), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-29-ingestao-mensal-automatica-design.md`

## Global Constraints

- Sem dependências de runtime novas. Única dev-dependency nova: `vitest@2.1.9`.
- Tabelas da Receita: `Empresa`, `Estabelecimento`, `Socio`, `Simples`, `Cnae`, `Motivo`, `Municipio`, `Natureza`, `Pais`, `Qualificacao`. Nada além delas é truncado.
- Não usar `SET UNLOGGED`/`SET LOGGED` em lugar nenhum.
- Ordem de grupos: `Cnae, Motivo, Municipio, Natureza, Pais, Qualificacao, Empresa, Simples, Estabelecimento, Socio`.
- Agenda: hora `INGEST_CRON_HOUR` (padrão `2`) no fuso `TZ` (padrão `America/Sao_Paulo`).
- Retry de falha temporária: a cada **30 min**. E-mail de falha: primeira falha e depois no máximo a cada **6 h**.
- Download: até **5** tentativas por arquivo, backoff 10 s dobrando até teto 300 s; timeout de inatividade do socket 60 s.
- Disco antes do download: livre ≥ `tamanhoZip × INGEST_DISK_FACTOR (6) + INGEST_MIN_FREE_GB (5) GiB`. Antes de cada índice: livre ≥ `pg_relation_size(tabela) × 1.5 + INGEST_MIN_FREE_GB GiB`.
- Mensagem 503 exata: `{ "error": "Servidor em manutenção: atualização da base da Receita Federal em andamento.", "code": "maintenance" }` com `Retry-After: 1800`.
- Aviso de cache exato: `A base da Receita foi atualizada em <dd/mm/aaaa> (mês <AAAA-MM>). Os números desta consulta podem estar defasados.`
- Mensagem de disco exata: `espaço insuficiente: <X> GB livres, <Y> GB necessários para <arquivo>` (GB com 1 casa decimal, GB = 1e9 bytes).
- Preço: exportação completa `max(1, ceil(total/10))`; diferença `ceil((totalAtual − totalSalvo)/10)`; descrição `Diferença de exportação após atualização da base: +<N> registros`, tipo `EXPORT_DIFF`.
- Destinatários: `INGEST_NOTIFY_EMAIL`, separados por vírgula. Falha de e-mail só loga.

### Decisões tomadas no plano (desvios/precisões sobre o spec)

1. `INGEST_MONTH` **não força mês** no agendador — só serve no primeiro deploy para registrar o mês já carregado (6.1). Forçar mês é feito por `npm run ingest:now -- AAAA-MM`. Motivo: se `INGEST_MONTH` forçasse sempre, o `.env` de produção (que já tem `INGEST_MONTH`) impediria meses novos de entrarem.
2. `ConsultaCache` ganha coluna anulável `totalAt DateTime?` (aditiva, sem tocar dados). Defasado = `(totalAt ?? createdAt) < loadedAt`. Sem isso, consulta reexportada (e recobrada) na base nova continuaria marcada como defasada para sempre.
3. Exportação: mês da base vai no header `X-Base-Mes` e numa aba extra `Info` (não mexe na aba `Estabelecimentos` nem no autoFilter).
4. `POST /consulta` não mostra custo hoje → só ganha `baseMes`/`baseAtualizadaEm`.
5. ZIP só é apagado **depois** do commit da carga (não logo após extrair): crash entre extrair e commitar não força rebaixar. Pico continua ≈ ZIP + CSV, coberto pelo fator 6.
6. Status extra `ABANDONED` para run de mês ultrapassado por mês mais novo.
7. Erro não classificado = permanente (evita martelar a Receita a cada 30 min).
8. No boot do serviço só se retoma run `RUNNING`; carga nova só no horário agendado.

## Review Focus

1. **Arquivo `.zip` da Receita com nome fora do padrão (PDF de layout, zip novo desconhecido)** → deve ser marcado `SKIPPED` e ignorado, não derrubar a carga. Teste em Task 4 (`zipTable`) e Task 9 (`skips unknown zip`).
2. **Servidor WebDAV ignora `Range` e responde 200** → arquivo parcial precisa ser truncado e baixado do zero, não anexado (arquivo corrompido). Teste em Task 5.
3. **Retomada depois de crash no meio do `INSERT`** → nada duplicado em `Socio`; arquivo continua `PENDING` e é recarregado inteiro. Teste em Task 7 (integração) e Task 9.
4. **Consulta salva com total que diminuiu após atualização** → reexportação grátis, sem crédito negativo nem reembolso estranho. Teste em Task 11.
5. **PROPFIND da raiz falha (rede) durante run `FAILED`** → nada quebra, nova tentativa no próximo retry; sem e-mail extra além do throttling. Teste em Task 3 (`decideNext` com `latestRemote: null`).

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/ingest/config.ts` | Ler env → `IngestConfig` |
| `src/ingest/errors.ts` | `TemporaryError`, `PermanentError`, `DiskSpaceError`, `classifyError` |
| `src/ingest/decide.ts` | Pura: o que fazer a cada gatilho; próxima execução |
| `src/ingest/webdav.ts` | PROPFIND (parse + chamadas) raiz e mês |
| `src/ingest/tables.ts` | `CONFIGS` movido de `src/ingest.ts`, ordem, mapa zip→tabela, índices secundários |
| `src/ingest/disk.ts` | `statfs`, cálculo de espaço exigido, asserts |
| `src/ingest/downloader.ts` | Download com `Range` + retry |
| `src/ingest/loader.ts` | Staging + COPY + INSERT num `pg.Client` já em transação |
| `src/ingest/state.ts` | Leitura/escrita de `IngestRun`/`IngestFile` (Prisma) |
| `src/ingest/db.ts` | Truncate, drop/create índices, ANALYZE, advisory lock |
| `src/ingest/notify.ts` | E-mails início/sucesso/falha |
| `src/ingest/run.ts` | Orquestrador de uma run |
| `src/ingest/scheduler.ts` | Processo longo: bootstrap, timers, chama `run` |
| `src/ingest/now.ts` | CLI manual |
| `src/lib/base-status.ts` | Estado da base para API (cache 30 s) + `isReceitaRoute` + `cacheNotice` |
| `src/lib/export-pricing.ts` | Pura: custo de exportação com cache |
| Remover | `src/download.ts`, `src/ingest.ts` |
| Testes | `test/**/*.test.ts` (Vitest) |

---

### Task 1: Vitest, schema e migration

**Files:**
- Modify: `package.json`, `prisma/schema.prisma`
- Create: `prisma/migrations/20261029000000_add_ingest_state/migration.sql`, `vitest.config.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces: modelos Prisma `IngestRun`, `IngestFile`; enum `IngestStatus { RUNNING SUCCESS FAILED ABANDONED }`, `IngestErrorKind { TEMPORARY PERMANENT }`, `IngestFileStatus { PENDING INGESTED SKIPPED }`; coluna `ConsultaCache.totalAt DateTime?`; script `npm test`.

- [ ] **Step 1:** `npm i -D vitest@2.1.9`; script `"test": "vitest run"`; `vitest.config.ts` com `test.include: ['test/**/*.test.ts']`, `environment: 'node'`.
- [ ] **Step 2:** `test/smoke.test.ts` com `expect(1).toBe(1)`; rodar `npm test` → PASS.
- [ ] **Step 3:** Adicionar ao `schema.prisma`:
  - `IngestRun`: `id String @id @default(cuid())`, `month String @db.VarChar(7)`, `status IngestStatus`, `prepared Boolean @default(false)`, `phase String?`, `error String?`, `errorKind IngestErrorKind?`, `lastFailureEmailAt DateTime?`, `startedAt DateTime @default(now())`, `finishedAt DateTime?`, `files IngestFile[]`, `@@index([status])`, `@@index([startedAt])`, `@@map("IngestRun")`.
  - `IngestFile`: `id String @id @default(cuid())`, `runId String`, relação `onDelete: Cascade`, `fileName String`, `size BigInt`, `tableName String?`, `status IngestFileStatus @default(PENDING)`, `rows Int?`, `discarded Int?`, `ingestedAt DateTime?`, `@@unique([runId, fileName])`, `@@map("IngestFile")`.
  - `ConsultaCache.totalAt DateTime?`.
- [ ] **Step 4:** Gerar SQL com `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (ou `migrate dev --create-only` contra banco local) e salvar no diretório da migration. Conferir que só há `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE "ConsultaCache" ADD COLUMN "totalAt"`.
- [ ] **Step 5:** `npx prisma generate && npx tsc --noEmit` → sem erro.
- [ ] **Step 6:** Commit `feat(ingest): add ingest state tables and vitest`.

### Task 2: Config e erros

**Files:**
- Create: `src/ingest/config.ts`, `src/ingest/errors.ts`
- Test: `test/ingest/config.test.ts`, `test/ingest/errors.test.ts`

**Interfaces:**
- Produces:
  - `interface IngestConfig { shareToken: string; tempDir: string; cronHour: number; timeZone: string; bootstrapMonth: string | null; minFreeBytes: number; diskFactor: number; notifyEmails: string[]; databaseUrl: string }`
  - `loadIngestConfig(env: NodeJS.ProcessEnv): IngestConfig` — lança `Error` se `SHARE_TOKEN`/`DATABASE_URL` ausentes, `INGEST_CRON_HOUR` fora de 0–23, `INGEST_MONTH` fora de `/^\d{4}-(0[1-9]|1[0-2])$/`. `tempDir` = `path.resolve('./temp')`. `minFreeBytes = INGEST_MIN_FREE_GB * 1024**3`.
  - `class TemporaryError extends Error`, `class PermanentError extends Error`, `class DiskSpaceError extends PermanentError`, `class HttpError extends Error { status: number }`.
  - `classifyError(err: unknown): 'TEMPORARY' | 'PERMANENT'`

- [ ] **Step 1: testes**
```ts
it('defaults', () => {
  const c = loadIngestConfig({ SHARE_TOKEN: 't', DATABASE_URL: 'x' });
  expect(c.cronHour).toBe(2); expect(c.timeZone).toBe('America/Sao_Paulo');
  expect(c.diskFactor).toBe(6); expect(c.minFreeBytes).toBe(5 * 1024 ** 3);
  expect(c.bootstrapMonth).toBeNull(); expect(c.notifyEmails).toEqual([]);
});
it('splits emails', () => expect(loadIngestConfig({ SHARE_TOKEN:'t', DATABASE_URL:'x', INGEST_NOTIFY_EMAIL:' a@x.com, b@y.com ' }).notifyEmails).toEqual(['a@x.com','b@y.com']));
it('rejects bad month', () => expect(() => loadIngestConfig({ SHARE_TOKEN:'t', DATABASE_URL:'x', INGEST_MONTH:'2026-13' })).toThrow());
it('rejects bad hour', () => expect(() => loadIngestConfig({ SHARE_TOKEN:'t', DATABASE_URL:'x', INGEST_CRON_HOUR:'24' })).toThrow());
```
```ts
it.each([
  [Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'TEMPORARY'],
  [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'TEMPORARY'],
  [Object.assign(new Error('x'), { code: 'EAI_AGAIN' }), 'TEMPORARY'],
  [Object.assign(new Error('x'), { code: '57P03' }), 'TEMPORARY'],
  [Object.assign(new Error('x'), { code: '08006' }), 'TEMPORARY'],
  [new HttpError(503, 'x'), 'TEMPORARY'],
  [new HttpError(429, 'x'), 'TEMPORARY'],
  [new HttpError(404, 'x'), 'PERMANENT'],
  [new HttpError(401, 'x'), 'PERMANENT'],
  [Object.assign(new Error('x'), { code: '53100' }), 'PERMANENT'],
  [new DiskSpaceError('x'), 'PERMANENT'],
  [new TemporaryError('x'), 'TEMPORARY'],
  [new Error('qualquer'), 'PERMANENT'],
])('classify %#', (e, k) => expect(classifyError(e)).toBe(k));
```
- [ ] **Step 2:** `npm test -- test/ingest` → FAIL (módulos inexistentes).
- [ ] **Step 3:** Implementar. Temporários: códigos `ECONNRESET ECONNREFUSED ETIMEDOUT ESOCKETTIMEDOUT EPIPE ENOTFOUND EAI_AGAIN 57P03 08000 08001 08004 08006`, `HttpError` 5xx/429, mensagem contendo `socket hang up`, `TemporaryError`.
- [ ] **Step 4:** `npm test -- test/ingest` → PASS.
- [ ] **Step 5:** Commit `feat(ingest): config loader and error classification`.

### Task 3: Decisão e agenda (puro)

**Files:**
- Create: `src/ingest/decide.ts`
- Test: `test/ingest/decide.test.ts`

**Interfaces:**
- Produces:
  - `type Trigger = 'startup' | 'daily' | 'retry' | 'manual'`
  - `interface OpenRun { id: string; month: string; status: 'RUNNING' | 'FAILED'; errorKind: 'TEMPORARY' | 'PERMANENT' | null; finishedAt: Date | null }`
  - `interface DecideInput { trigger: Trigger; lastSuccessMonth: string | null; openRun: OpenRun | null; latestRemote: string | null; forcedMonth?: string }`
  - `type Decision = { kind: 'none'; reason: string } | { kind: 'resume'; runId: string } | { kind: 'start'; month: string; abandonRunId?: string }`
  - `decideNext(i: DecideInput): Decision`
  - `latestMonth(folders: string[]): string | null` — filtra `/^\d{4}-\d{2}$/`, retorna maior.
  - `nextDailyRun(now: Date, hour: number, timeZone: string): Date` — próximo instante com hora local == `hour`:00 estritamente após `now` (usar `Intl.DateTimeFormat` para partes locais).
  - `nextWakeUp(now: Date, daily: Date, openRun: OpenRun | null): { at: Date; trigger: 'daily' | 'retry' }` — se `openRun` FAILED+TEMPORARY, `retryAt = (finishedAt ?? now) + 30 min`; vence o menor.

Regras de `decideNext` (em ordem):
1. `manual` com `forcedMonth`: `start(forcedMonth, abandonRunId = openRun?.id se openRun.month !== forcedMonth)`; se `openRun.month === forcedMonth` → `resume`.
2. `openRun.status === 'RUNNING'` → `resume`.
3. `startup` → `none` se não houver RUNNING.
4. `openRun` FAILED: se `latestRemote > openRun.month` → `start(latestRemote, abandonRunId)`; se `trigger === 'retry'` e `errorKind !== 'TEMPORARY'` → `none`; senão → `resume`.
5. `latestRemote === null` → `none`.
6. `lastSuccessMonth === null || latestRemote > lastSuccessMonth` → `start(latestRemote)`; senão `none`.

- [ ] **Step 1: testes** (cada um uma `it`):
```ts
const failedTemp = { id:'r1', month:'2026-09', status:'FAILED', errorKind:'TEMPORARY', finishedAt:new Date('2026-10-01T06:00:00Z') } as const;
expect(decideNext({ trigger:'daily', lastSuccessMonth:'2026-09', openRun:null, latestRemote:'2026-10' })).toEqual({ kind:'start', month:'2026-10' });
expect(decideNext({ trigger:'daily', lastSuccessMonth:'2026-10', openRun:null, latestRemote:'2026-10' }).kind).toBe('none');
expect(decideNext({ trigger:'daily', lastSuccessMonth:null, openRun:null, latestRemote:'2026-10' })).toEqual({ kind:'start', month:'2026-10' });
expect(decideNext({ trigger:'startup', lastSuccessMonth:'2026-09', openRun:null, latestRemote:'2026-10' }).kind).toBe('none');
expect(decideNext({ trigger:'startup', lastSuccessMonth:'2026-09', openRun:{...failedTemp, status:'RUNNING'}, latestRemote:null })).toEqual({ kind:'resume', runId:'r1' });
expect(decideNext({ trigger:'retry', lastSuccessMonth:'2026-08', openRun:failedTemp, latestRemote:'2026-09' })).toEqual({ kind:'resume', runId:'r1' });
expect(decideNext({ trigger:'retry', lastSuccessMonth:'2026-08', openRun:{...failedTemp, errorKind:'PERMANENT'}, latestRemote:'2026-09' }).kind).toBe('none');
expect(decideNext({ trigger:'daily', lastSuccessMonth:'2026-08', openRun:{...failedTemp, errorKind:'PERMANENT'}, latestRemote:'2026-09' })).toEqual({ kind:'resume', runId:'r1' });
expect(decideNext({ trigger:'retry', lastSuccessMonth:'2026-08', openRun:failedTemp, latestRemote:'2026-10' })).toEqual({ kind:'start', month:'2026-10', abandonRunId:'r1' });
expect(decideNext({ trigger:'retry', lastSuccessMonth:'2026-08', openRun:failedTemp, latestRemote:null })).toEqual({ kind:'resume', runId:'r1' }); // Review Focus 5: segue; run.ts falha de novo como TEMPORARY
expect(decideNext({ trigger:'manual', forcedMonth:'2026-07', lastSuccessMonth:'2026-09', openRun:null, latestRemote:'2026-10' })).toEqual({ kind:'start', month:'2026-07' });
expect(latestMonth(['2026-09','2026-10','temp','2025-12','2026-1'])).toBe('2026-10');
expect(nextDailyRun(new Date('2026-10-29T04:59:00Z'), 2, 'America/Sao_Paulo').toISOString()).toBe('2026-10-29T05:00:00.000Z');
expect(nextDailyRun(new Date('2026-10-29T05:00:00Z'), 2, 'America/Sao_Paulo').toISOString()).toBe('2026-10-30T05:00:00.000Z');
const daily = new Date('2026-10-30T05:00:00Z');
expect(nextWakeUp(new Date('2026-10-29T06:10:00Z'), daily, { ...failedTemp, finishedAt:new Date('2026-10-29T06:00:00Z') })).toEqual({ at:new Date('2026-10-29T06:30:00Z'), trigger:'retry' });
expect(nextWakeUp(new Date('2026-10-29T06:10:00Z'), daily, null)).toEqual({ at:daily, trigger:'daily' });
```
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): pure run decision and scheduling`.

### Task 4: WebDAV e tabelas

**Files:**
- Create: `src/ingest/webdav.ts`, `src/ingest/tables.ts`
- Test: `test/ingest/webdav.test.ts`, `test/ingest/tables.test.ts`, fixture `test/fixtures/propfind-root.xml`, `test/fixtures/propfind-month.xml`

**Interfaces:**
- Produces:
  - `interface DavEntry { name: string; href: string; size: number | null; isDir: boolean }`
  - `parsePropfind(xml: string): DavEntry[]` — usa a mesma abordagem por regex de `src/download.ts` (`listarArquivos`), mais `<d:collection/>` em `resourcetype` para `isDir`; ignora a entrada da própria pasta consultada (primeira, mesmo href da requisição).
  - `listRemoteMonths(cfg: IngestConfig): Promise<string[]>` — PROPFIND `Depth: 1` em `https://arquivos.receitafederal.gov.br/public.php/webdav/`, retorna nomes de diretórios.
  - `listMonthFiles(cfg: IngestConfig, month: string): Promise<DavEntry[]>` — só arquivos (`!isDir`) com `size`.
  - Ambas lançam `HttpError(status)` se status ≠ 207. Helpers `davAuthHeader(cfg)`, `DAV_HOST = 'arquivos.receitafederal.gov.br'`, `davMonthUrl(month)` exportados para Task 5.
  - `tables.ts`: `CONFIGS` e `TabelaConfig` movidos sem alteração de `src/ingest.ts` (exceto `conflito`, ver abaixo); `TABLE_ORDER: string[]` (Global Constraints); `RECEITA_TABLES = TABLE_ORDER`; `zipTable(fileName: string): string | null`; `configForCsv(fileName: string): TabelaConfig | null` (mesma regra de `listarPorExtensao`: `nameContains` ou sufixo); `SECONDARY_INDEXES: Record<string, { name: string; sql: string }[]>`.
  - `Socio.conflito` continua `null`; demais mantêm `ON CONFLICT ... DO NOTHING`.

`zipTable` (case-insensitive, prefixo do nome antes de dígitos/`.zip`): `cnaes→Cnae`, `motivos→Motivo`, `municipios→Municipio`, `naturezas→Natureza`, `paises→Pais`, `qualificacoes→Qualificacao`, `empresas→Empresa`, `simples→Simples`, `estabelecimentos→Estabelecimento`, `socios→Socio`; não-`.zip` ou outro prefixo → `null`.

`SECONDARY_INDEXES`:
- `Empresa`: `idx_razao_social_trgm` (SQL de `CONFIGS['.EMPRECSV'].indexes`).
- `Estabelecimento`: `idx_estab_cnpj_base`, `idx_estab_uf`, `idx_estab_cnae` (de `CONFIGS`), `Estabelecimento_uf_municipio_idx` `("uf","municipio")`, `Estabelecimento_uf_cnae_idx` `("uf","cnae_fiscal_principal")`.
- `Socio`: `idx_socio_cnpj_base`, `idx_socio_cpf`.
- Remover o campo `indexes` de `TabelaConfig` (agora vive aqui).

- [ ] **Step 1: testes** — fixtures com raiz contendo `2026-09/`, `2026-10/`, arquivo solto; mês com `Empresas0.zip` (size 123), `Socios3.zip`, `LAYOUT.pdf`.
```ts
expect(parsePropfind(root).filter(e => e.isDir).map(e => e.name)).toEqual(['2026-09','2026-10']);
expect(parsePropfind(month).find(e => e.name === 'Empresas0.zip')).toMatchObject({ size:123, isDir:false });
expect(zipTable('Empresas0.zip')).toBe('Empresa');
expect(zipTable('ESTABELECIMENTOS9.ZIP')).toBe('Estabelecimento');
expect(zipTable('Simples.zip')).toBe('Simples');
expect(zipTable('Qualificacoes.zip')).toBe('Qualificacao');
expect(zipTable('LAYOUT.pdf')).toBeNull();
expect(zipTable('Novidade.zip')).toBeNull();          // Review Focus 1
expect(configForCsv('K3241.K03200Y0.D30513.EMPRECSV')?.tabela).toBe('Empresa');
expect(configForCsv('F.K03200$W.SIMPLES.CSV.D30513')?.tabela).toBe('Simples');
expect(SECONDARY_INDEXES.Estabelecimento.map(i => i.name)).toContain('Estabelecimento_uf_cnae_idx');
```
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): webdav parsing and table mapping`.

### Task 5: Disco e downloader

**Files:**
- Create: `src/ingest/disk.ts`, `src/ingest/downloader.ts`
- Test: `test/ingest/disk.test.ts`, `test/ingest/downloader.test.ts`

**Interfaces:**
- Consumes: `IngestConfig`, `HttpError`, `DiskSpaceError`, `davAuthHeader`, `DAV_HOST`.
- Produces:
  - `freeBytes(dir: string): Promise<number>` — `fs.promises.statfs(dir)` → `bavail * bsize`.
  - `requiredForZip(zipSize: number, cfg: Pick<IngestConfig,'diskFactor'|'minFreeBytes'>): number`
  - `requiredForIndex(tableBytes: number, cfg: Pick<IngestConfig,'minFreeBytes'>): number` — `ceil(tableBytes*1.5) + minFreeBytes`
  - `assertSpace(free: number, required: number, label: string): void` — lança `DiskSpaceError` com a mensagem exata dos Global Constraints.
  - `downloadFile(opts: { url: string; dest: string; size: number; headers: Record<string,string>; log?: (m: string) => void; sleep?: (ms: number) => Promise<void>; maxAttempts?: number; idleTimeoutMs?: number }): Promise<void>` — segue redirects (até 5, como hoje). Se `dest` existe com tamanho `< size` → envia `Range: bytes=<local>-`; 206 → append; 200 → trunca e escreve do zero; tamanho local `== size` → retorna sem rede; `> size` → apaga e baixa do zero. Ao fim, tamanho ≠ `size` → `TemporaryError`. Erros classificados `TEMPORARY` são re-tentados com backoff (10 s, 20 s, 40 s, 80 s; teto 300 s) até `maxAttempts` (5); `PERMANENT` relança na hora.

- [ ] **Step 1: testes** — servidor `http.createServer` local em porta 0 servindo um buffer de 1000 bytes; respeita `Range` num modo e ignora noutro; modo que derruba conexão após 300 bytes na 1ª requisição. `sleep` injetado como no-op.
```ts
expect(requiredForZip(1e9, { diskFactor:6, minFreeBytes:5*1024**3 })).toBe(6e9 + 5*1024**3);
expect(() => assertSpace(10e9, 12.34e9, 'Empresas0.zip')).toThrow('espaço insuficiente: 10.0 GB livres, 12.3 GB necessários para Empresas0.zip');
it('resumes with Range after drop', ...)           // arquivo final === buffer; 2ª requisição tinha header range 'bytes=300-'
it('restarts when server ignores Range', ...)      // Review Focus 2: parcial de 300 bytes pré-existente + servidor 200 → arquivo final === buffer (1000 bytes, não 1300)
it('skips when local size equals remote', ...)     // servidor não recebe requisição
it('gives up after maxAttempts on 503', ...)       // rejects HttpError status 503; servidor recebeu 5 requisições
it('fails immediately on 404', ...)                // 1 requisição
```
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): disk guard and resumable downloader`.

### Task 6: Estado da ingestão (Prisma)

**Files:**
- Create: `src/ingest/state.ts`
- Test: `test/ingest/state.int.test.ts` (integração; `describe.skipIf(!process.env.TEST_DATABASE_URL)`)

**Interfaces:**
- Consumes: modelos de Task 1, `OpenRun` de Task 3, `DavEntry`, `zipTable`.
- Produces (todas recebem `prisma: PrismaClient`):
  - `getLastSuccess(prisma): Promise<{ month: string; finishedAt: Date } | null>`
  - `getOpenRun(prisma): Promise<OpenRun | null>` — run mais recente por `startedAt` com status `RUNNING|FAILED`, **somente se** não houver `SUCCESS` com `startedAt` posterior.
  - `createRun(prisma, month: string): Promise<string>` — status `RUNNING`.
  - `abandonRun(prisma, runId: string): Promise<void>`
  - `markRunning(prisma, runId)`, `markPrepared(prisma, runId)`, `setPhase(prisma, runId, phase: string)`
  - `markSuccess(prisma, runId): Promise<void>` — `finishedAt = now`, limpa `error/errorKind`.
  - `markFailed(prisma, runId, error: string, kind: 'TEMPORARY'|'PERMANENT'): Promise<{ shouldEmail: boolean }>` — `shouldEmail` = `lastFailureEmailAt` nulo ou > 6 h; se `true`, grava `lastFailureEmailAt = now`.
  - `registerFiles(prisma, runId, entries: DavEntry[]): Promise<void>` — `createMany skipDuplicates`; `tableName = zipTable(name)`; `status = SKIPPED` quando `tableName` nulo.
  - `pendingFiles(prisma, runId): Promise<{ fileName: string; size: number; tableName: string }[]>`
  - `MARK_INGESTED_SQL` — `UPDATE "IngestFile" SET status='INGESTED', rows=$3, discarded=$4, "ingestedAt"=now() WHERE "runId"=$1 AND "fileName"=$2` (usado em `pg.Client` dentro da transação da carga).
  - `bootstrapIfNeeded(prisma, cfg: IngestConfig, log): Promise<void>` — se `IngestRun.count() === 0` e `SELECT EXISTS (SELECT 1 FROM "Empresa" LIMIT 1)`: com `cfg.bootstrapMonth` cria run `SUCCESS` (`prepared=true`, `finishedAt=now`); sem ele, `log` de erro `INGEST_MONTH obrigatório no primeiro deploy com base já carregada` e lança `PermanentError` (scheduler não agenda carga).
  - `latestRunStatus(prisma): Promise<{ month: string | null; loadedAt: Date | null; maintenance: boolean }>` — usado pela API (Task 11). `month`/`loadedAt` = `getLastSuccess` (`finishedAt`); `maintenance = getOpenRun(...) !== null`.

- [ ] **Step 1: testes de integração** (truncar `IngestRun` em `beforeEach`):
```ts
it('open run hidden after later success', ...)        // FAILED(2026-09) depois SUCCESS(2026-10) → getOpenRun null
it('markFailed throttles e-mail 6h', ...)             // 1ª true; 2ª imediata false; com lastFailureEmailAt = now-7h → true
it('registerFiles marks unknown as SKIPPED', ...)     // LAYOUT.pdf → SKIPPED; pendingFiles não inclui
it('registerFiles idempotent', ...)                   // chamar 2× não duplica nem reseta INGESTED
it('bootstrap records SUCCESS when base has data', ...) // insere 1 Empresa; bootstrapMonth '2026-06' → getLastSuccess().month === '2026-06'
it('bootstrap no-op when tables empty', ...)
```
- [ ] **Step 2:** `TEST_DATABASE_URL=... npm test -- state` → FAIL. (Banco: `docker compose up postgres` + `prisma migrate deploy` com essa URL. Sem banco, a suíte é pulada — registrar isso no relatório da task.)
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): persistent ingest state`.

### Task 7: Loader e operações de banco

**Files:**
- Create: `src/ingest/loader.ts`, `src/ingest/db.ts`
- Test: `test/ingest/loader.int.test.ts` (skipIf sem `TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `TabelaConfig`, `CONFIGS`, `SECONDARY_INDEXES`, `RECEITA_TABLES`, `MARK_INGESTED_SQL`, `requiredForIndex`, `assertSpace`, `freeBytes`.
- Produces:
  - `loadCsv(client: pg.Client, csvPath: string, config: TabelaConfig): Promise<{ rows: number; inserted: number }>` — corpo de `processarArquivo` (`src/ingest.ts:347-419`) **sem** abrir/fechar conexão e sem `DROP TABLE` no `catch` (quem chama controla `BEGIN/ROLLBACK`); staging criada com `ON COMMIT DROP`. `escapeCopy`, `col`, `colOpt` vão junto para `loader.ts`.
  - `connect(databaseUrl: string): Promise<pg.Client>` — `connectWithRetry` movido.
  - `truncateReceita(client): Promise<void>` — `TRUNCATE` de `RECEITA_TABLES` numa instrução, `RESTART IDENTITY`.
  - `dropSecondaryIndexes(client): Promise<void>` — `DROP INDEX IF EXISTS` para todos de `SECONDARY_INDEXES`.
  - `buildIndexes(client, table: string, cfg, tempDir: string, log): Promise<void>` — para cada índice ausente em `pg_indexes`: `assertSpace(await freeBytes(tempDir), requiredForIndex(pg_relation_size, cfg), 'índice <nome>')`, depois o `CREATE INDEX IF NOT EXISTS`; ao fim `ANALYZE "<tabela>"`.
  - `tryAdvisoryLock(client): Promise<boolean>` — `pg_try_advisory_lock(727011)`.

- [ ] **Step 1: testes de integração**
```ts
it('loads Socio rows and marks file in same tx', ...)
// arquivo SOCIOCSV de 3 linhas win1252 (com "ç"); BEGIN; loadCsv; MARK_INGESTED_SQL; COMMIT → count Socio 3, nome com "ç", IngestFile INGESTED rows 3
it('rollback leaves no rows and file PENDING', ...)   // Review Focus 3: BEGIN; loadCsv; ROLLBACK → count 0, status PENDING; repetir carga commitada → count 3 (sem duplicar)
it('Empresa duplicate in source counts discarded', ...) // 2 linhas mesmo cnpj_base → rows 2, inserted 1
it('truncate leaves User untouched', ...)             // 1 User + 1 Empresa → truncateReceita → User 1, Empresa 0
it('drop and build indexes', ...)                     // após drop, pg_indexes sem idx_socio_cpf; buildIndexes('Socio') → existe
it('buildIndexes throws DiskSpaceError when minFreeBytes huge', ...)
```
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): transactional csv loader and db ops`.

### Task 8: Notificações por e-mail

**Files:**
- Modify: `src/services/email.service.ts` (exportar `createTransporter`)
- Create: `src/ingest/notify.ts`
- Test: `test/ingest/notify.test.ts`

**Interfaces:**
- Produces:
  - `interface Mailer { sendMail(m: { from?: string; to: string; subject: string; html: string }): Promise<unknown> }`
  - `createNotifier(cfg: Pick<IngestConfig,'notifyEmails'>, mailer: Mailer, log: (m: string) => void): Notifier`
  - `interface Notifier { started(month: string): Promise<void>; succeeded(r: { month: string; durationMs: number; rowsByTable: Record<string, number>; recovered: boolean }): Promise<void>; failed(r: { month: string; phase: string | null; error: string; kind: 'TEMPORARY'|'PERMANENT'; freeBytes: number | null }): Promise<void> }`
  - Assuntos: `[CNPJ] Atualização da base <mês> iniciada`, `[CNPJ] Base <mês> atualizada com sucesso`, `[CNPJ] Falha na atualização da base <mês>`. Corpo de falha diz `Nova tentativa automática em 30 minutos.` (TEMPORARY) ou `Nova tentativa na próxima verificação diária ou via npm run ingest:now.` (PERMANENT). HTML no estilo de `sendPasswordResetEmail`.
  - Sem destinatários → não envia, loga uma vez. Erro do mailer → loga, não lança.

- [ ] **Step 1: testes** com mailer fake:
```ts
it('sends to all recipients joined', ...)        // to === 'a@x.com, b@y.com'
it('failure mentions 30 min for TEMPORARY', ...)  // html contém 'Nova tentativa automática em 30 minutos.'
it('swallows mailer errors', ...)                 // mailer rejeita → promise resolve
it('no recipients → no send', ...)
```
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): e-mail notifications`.

### Task 9: Orquestrador da run

**Files:**
- Create: `src/ingest/run.ts`
- Test: `test/ingest/run.test.ts`

**Interfaces:**
- Consumes: tudo acima.
- Produces:
  - `interface RunDeps { cfg: IngestConfig; prisma: PrismaClient; db: pg.Client; listMonthFiles: typeof listMonthFiles; downloadFile: typeof downloadFile; extractZip: (zip: string, destDir: string) => Promise<string[]>; loadCsv: typeof loadCsv; freeBytes: typeof freeBytes; notifier: Notifier; log: (m: string) => void; now?: () => Date }`
  - `executeRun(runId: string, deps: RunDeps): Promise<void>` — não lança: todo erro é capturado, classificado (`classifyError`), gravado com `markFailed` e notificado com `notifier.failed` quando `shouldEmail`. O scheduler só agenda.

Fluxo de `executeRun`:
1. Ler run; `markRunning`; se não `prepared`: limpar `cfg.tempDir` inteiro, `truncateReceita`, `dropSecondaryIndexes`, `markPrepared`, `notifier.started(month)`.
2. `registerFiles(await listMonthFiles(cfg, month))`.
3. Limpar órfãos em `tempDir`: apagar tudo exceto arquivos cujo nome está em `pendingFiles` (parciais de ZIP).
4. Para cada tabela em `TABLE_ORDER`: para cada pendente da tabela (ordem por nome): `setPhase('<tabela>: <arquivo>')`; `assertSpace(freeBytes, requiredForZip(size))` — **pular** a checagem se o ZIP já está completo no disco; `downloadFile`; `extractZip` para `tempDir/<runId>/`; para cada CSV: `configForCsv` deve ter `tabela === tableName`, senão `PermanentError('arquivo inesperado <csv> em <zip>')`; `BEGIN` → `loadCsv` p/ cada CSV → `MARK_INGESTED_SQL` (rows somados, discarded = rows − inserted) → `COMMIT` (em erro `ROLLBACK` e relança); apagar CSVs e ZIP; logar espaço livre. Depois dos arquivos da tabela: `buildIndexes(tabela)` (idempotente).
5. `markSuccess`, `notifier.succeeded({ recovered: run tinha errorKind antes })`; limpar `tempDir`.

- [ ] **Step 1: testes** com Prisma/pg reais quando `TEST_DATABASE_URL` existir; `listMonthFiles`, `downloadFile`, `extractZip`, `notifier` fakes (extract escreve CSVs de fixture):
```ts
it('fresh run truncates, loads in TABLE_ORDER, marks SUCCESS', ...) // ordem de loadCsv: Cnae... antes de Empresa antes de Socio; Empresa pré-existente some
it('resume skips INGESTED and does not truncate', ...)               // run prepared=true com Empresas0 INGESTED → download não chamado p/ ele; Empresa mantém linhas
it('skips unknown zip', ...)                                         // Review Focus 1: LAYOUT.pdf e Novidade.zip na listagem → não baixados, run SUCCESS
it('crash mid-load does not duplicate Socio', ...)                   // Review Focus 3: loadCsv fake lança na 1ª vez → FAILED; 2ª executeRun → Socio count = linhas do arquivo
it('disk check fails permanently', ...)                              // freeBytes fake 1 → FAILED PERMANENT, erro começa com 'espaço insuficiente', notifier.failed chamado, download não chamado
it('temporary error emails once in 6h', ...)                         // download rejeita HttpError 503 duas vezes seguidas → notifier.failed 1×
it('unexpected csv inside zip is permanent', ...)
```
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Commit `feat(ingest): run orchestrator with resume and disk guard`.

### Task 10: Scheduler, CLI, Docker e limpeza

**Files:**
- Create: `src/ingest/scheduler.ts`, `src/ingest/now.ts`
- Delete: `src/download.ts`, `src/ingest.ts`
- Modify: `package.json`, `docker-compose.yml`, `Dockerfile` (nada no runtime se não precisar), `.env.example`
- Test: `test/ingest/scheduler.test.ts`

**Interfaces:**
- Consumes: `decideNext`, `nextDailyRun`, `nextWakeUp`, `latestMonth`, `listRemoteMonths`, state, `executeRun`, `tryAdvisoryLock`.
- Produces:
  - `tick(trigger: Trigger, deps: RunDeps & { listRemoteMonths: typeof listRemoteMonths }, forcedMonth?: string): Promise<Decision>` — pega lock (sem lock → loga e retorna `none`); `listRemoteMonths` com falha → `latestRemote = null` (loga); `decideNext`; aplica (`abandonRun`, `createRun`, `executeRun`); libera lock.
  - `scheduler.ts` como entrypoint: `loadIngestConfig`, `bootstrapIfNeeded` (erro → loga, continua só retomando RUNNING), `tick('startup')`, depois loop `nextWakeUp` + `setTimeout` → `tick(trigger)`. `SIGTERM` → encerra conexões e sai 0.
  - `now.ts`: `tick('manual', deps, process.argv[2])`, sai 0 se run terminou `SUCCESS` ou `none`, 1 se `FAILED`.
  - Scripts: `"ingest": "node dist/ingest/now.js"`, `"ingest:now": "ts-node src/ingest/now.ts"`, `"ingest:scheduler": "node dist/ingest/scheduler.js"`, `"dev:ingest": "ts-node src/ingest/scheduler.ts"`; remover `"download"`.

- [ ] **Step 1: teste** do `tick` com deps fakes:
```ts
it('lock held → none without listing', ...)
it('remote listing failure on daily → none', ...)
it('start abandons old run', ...)  // decideNext start com abandonRunId → abandonRun chamado antes de createRun
```
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** `docker-compose.yml` serviço `ingest`: remover `profiles`, `restart: unless-stopped`, env `SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM INGEST_NOTIFY_EMAIL INGEST_CRON_HOUR INGEST_MIN_FREE_GB INGEST_DISK_FACTOR TZ`, `command: ['sh','-c','for i in 1 2 3 4 5 6 7 8 9 10; do npx prisma migrate deploy && break; sleep 5; done && node dist/ingest/scheduler.js']`. `.env.example`: novas vars com padrões da tabela 6.9, comentário em `INGEST_MONTH` ("só no primeiro deploy: mês já carregado").
- [ ] **Step 6:** `npm run build && npm test` → PASS; `grep -r "download.js\|dist/ingest.js" docker-compose.yml Dockerfile package.json` → vazio.
- [ ] **Step 7:** Commit `feat(ingest): long-running scheduler replaces manual pipeline`.

### Task 11: API — manutenção, status da base, aviso de cache, cobrança da diferença

**Files:**
- Create: `src/lib/base-status.ts`, `src/lib/export-pricing.ts`
- Modify: `src/api.ts` (hook, `/health`, `/base/status`), `src/routes/consulta.ts` (`/consultas/minhas`, `/consulta`, `/consulta/exportar`), `src/routes/credits.ts` (`/user/credits`)
- Test: `test/api/base-status.test.ts`, `test/api/export-pricing.test.ts`

**Interfaces:**
- Consumes: `latestRunStatus` (Task 6).
- Produces:
  - `interface BaseStatus { month: string | null; loadedAt: Date | null; maintenance: boolean }`
  - `getBaseStatus(): Promise<BaseStatus>` — `latestRunStatus(prisma)` com cache em memória de 30 s; erro de banco → último valor conhecido ou `{ month:null, loadedAt:null, maintenance:false }`.
  - `isReceitaRoute(url: string): boolean` — path sem query; `true` para `/empresas`, `/empresas/*`, `/cnpj/*`, `/consulta`, `/consulta/exportar`, `/cnaes/*`, `/municipios`; `false` para o resto (inclui `/consultas/minhas`).
  - `cacheNotice(totalAt: Date, base: BaseStatus): { baseDesatualizada: boolean; aviso: string | null }` — data em `dd/mm/aaaa` no fuso `America/Sao_Paulo`.
  - `MAINTENANCE_BODY` (exato dos Global Constraints).
  - `exportPricing(total: number, cached: { total: number } | null): { cost: number; kind: 'full' | 'diff' | 'free' }`

Mudanças:
- `api.ts`: segundo `onRequest` (depois da chave interna) → se `isReceitaRoute(request.url)` e `(await getBaseStatus()).maintenance` → `503`, `Retry-After: 1800`, `MAINTENANCE_BODY`. `/health` → `{ status: 'ok', maintenance }`. Novo `GET /base/status` → `{ month, loadedAt, maintenance }`.
- `/consultas/minhas`: selecionar `totalAt`; cada item recebe `...cacheNotice(c.totalAt ?? c.createdAt, base)`.
- `/user/credits`: idem no objeto `consultaCache` (selecionar `createdAt`, `totalAt`).
- `/consulta`: resposta `{ total, baseMes, baseAtualizadaEm }`.
- `/consulta/exportar`: `exportPricing(total, isCached ? cached : null)`; `full` → `deductCredits(..., 'EXPORT', <descrição atual>)`; `diff` → `deductCredits(..., 'EXPORT_DIFF', 'Diferença de exportação após atualização da base: +<N> registros')` com `N = total − cached.total` formatado `pt-BR`; reembolso no `catch` quando `cost > 0` (troca o `!isCached && exportCost > 0`). Após sucesso: `full` → upsert atual + `totalAt: now`; `diff` → `update { total, totalAt: now }` (sem mexer em `expiresAt`); `free` → nada. Aba `Info` com linhas `['Base Receita Federal', baseMes ?? '']`, `['Atualizada em', dd/mm/aaaa ?? '']`; header `X-Base-Mes`.

- [ ] **Step 1: testes**
```ts
expect(exportPricing(95, null)).toEqual({ cost:10, kind:'full' });
expect(exportPricing(3, null)).toEqual({ cost:1, kind:'full' });
expect(exportPricing(120, { total:100 })).toEqual({ cost:2, kind:'diff' });
expect(exportPricing(101, { total:100 })).toEqual({ cost:1, kind:'diff' });
expect(exportPricing(100, { total:100 })).toEqual({ cost:0, kind:'free' });
expect(exportPricing(80, { total:100 })).toEqual({ cost:0, kind:'free' });   // Review Focus 4
expect(isReceitaRoute('/consulta?x=1')).toBe(true);
expect(isReceitaRoute('/consultas/minhas')).toBe(false);
expect(isReceitaRoute('/cnpj/123')).toBe(true);
expect(isReceitaRoute('/stripe/webhook')).toBe(false);
expect(isReceitaRoute('/health')).toBe(false);
const base = { month:'2026-10', loadedAt:new Date('2026-10-29T12:00:00Z'), maintenance:false };
expect(cacheNotice(new Date('2026-10-01T00:00:00Z'), base)).toEqual({ baseDesatualizada:true, aviso:'A base da Receita foi atualizada em 29/10/2026 (mês 2026-10). Os números desta consulta podem estar defasados.' });
expect(cacheNotice(new Date('2026-10-30T00:00:00Z'), base)).toEqual({ baseDesatualizada:false, aviso:null });
expect(cacheNotice(new Date(), { month:null, loadedAt:null, maintenance:false })).toEqual({ baseDesatualizada:false, aviso:null });
```
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** `npm run build && npm test` → PASS. Verificação manual com `npm run dev:api` e banco local: inserir `IngestRun` `RUNNING` → `curl -H "x-internal-api-key: $K" localhost:3333/municipios` = 503 com corpo exato; `/health` = 200 `maintenance:true`; `/auth/login` não é 503 (dentro de 30 s do cache).
- [ ] **Step 6:** Commit `feat(api): maintenance mode, base status, stale cache notice, diff pricing`.
