# Ingestão mensal automática da base da Receita Federal — Design

Data: 2026-10-29
Status: rascunho para aprovação

## 1. Intenção

Hoje a base de CNPJ é atualizada à mão: alguém troca `INGEST_MONTH` no `.env`, sobe o serviço `ingest` com `--profile ingest`, e o pipeline `download.ts` → `ingest.ts` roda. O objetivo é que o sistema **descubra sozinho** quando a Receita publica um mês novo e **substitua a base inteira** por esse mês, sem intervenção, respeitando o disco limitado do servidor e se recuperando de falhas.

Além do agendamento, a carga atual não serve para recarga mensal:

- `ON CONFLICT DO NOTHING` em `Empresa`, `Estabelecimento`, `Simples` e lookups → registros existentes nunca são atualizados.
- `Socio` não tem chave natural → cada carga duplica todos os sócios.
- Empresas que saíram da base nunca são removidas.
- `temp/.progresso.json` guarda só nome de arquivo; se a Receita repetir nomes entre meses, arquivos do mês novo são pulados.
- O download recomeça do zero um arquivo que caiu no meio.
- O download baixa e extrai tudo antes de ingerir → pico de disco = base inteira em ZIP/CSV + banco.

## 2. Objetivos

1. Verificação automática diária, de madrugada, de pasta `AAAA-MM` nova no WebDAV da Receita.
2. Quando houver mês novo: colocar API em manutenção, apagar dados antigos da Receita, carregar o mês novo do zero, recriar índices, sair da manutenção.
3. Retomar de onde parou em caso de queda de download (retomada no meio do arquivo) e em caso de morte do processo (retomada por arquivo).
4. Controlar o disco: nunca guardar a base inteira em arquivos; checar espaço antes de cada passo; abortar com erro claro em vez de encher.
5. Enviar e-mail ao fim (sucesso ou falha) para endereço definido em variável de ambiente.
6. Informar aos usuários que a base foi atualizada e que consultas salvas (cache) podem ter números defasados.

## 3. Não-objetivos

- Manter a API servindo os dados do mês anterior durante a carga (o usuário aceitou ficar offline em manutenção).
- Carga incremental / diff entre meses. Sempre recarga completa.
- Limpar ou invalidar `ConsultaCache`. O cache **permanece** (só muda a cobrança da diferença, 6.8).
- Alterar o frontend. Este projeto entrega só o contrato da API (503 de manutenção, campos de aviso); o frontend adota quando puder. *Pergunta sobre o frontend ficou sem resposta — tratado como fora de escopo.*
- Painel/UI de administração da ingestão.
- Alterar tabelas de usuário, créditos, transações Stripe, tokens.

## 4. Anti-objetivos (falha mesmo que "funcione")

- API servir base pela metade sem estar em modo manutenção.
- Disco do servidor encher durante a carga.
- Sócios duplicados ou dados de dois meses misturados após uma retomada.
- Uma falha deixar o sistema travado em manutenção sem ninguém ser avisado.
- Tocar em `User`, `CreditTransaction`, `ConsultaCache`, `PasswordResetToken`.

## 5. Restrições

- Stack existente: TypeScript, Node 20, Fastify, Prisma 5, `pg` + `pg-copy-streams`, Docker Compose. Construir sobre `src/download.ts` e `src/ingest.ts` (reaproveitar `CONFIGS`, `escapeCopy`, COPY via staging, `connectWithRetry`, SMTP de `src/services/email.service.ts`).
- Disco: **100 GB total, ~59 GB ocupados (~41 GB livres)** em 2026-10-29, confirmado pelo usuário; banco e `temp/` no **mesmo disco** (confirmado). A maior parte do ocupado deve ser a própria base da Receita, liberada pelo `TRUNCATE` antes do primeiro download.
- Volumes `pgdata` e `ingest_temp` provavelmente no mesmo disco do host. Se estiverem, `fs.statfs` em `temp/` mede o disco do banco também. Checagens de disco antes de índices usam o mesmo `statfs`.
- Carga leva algumas horas; pode passar da madrugada e entrar pela manhã — aceito.
- Origem: `https://arquivos.receitafederal.gov.br/public.php/webdav/<AAAA-MM>/`, Basic auth com `SHARE_TOKEN` (já usado).
- Tabelas da Receita (`Empresa`, `Estabelecimento`, `Socio`, `Simples`, `Cnae`, `Motivo`, `Municipio`, `Natureza`, `Pais`, `Qualificacao`) não têm FKs entre si nem com outras tabelas.
- Postgres trunca tabelas UNLOGGED na recuperação após crash e `SET LOGGED` duplica a tabela no WAL — por isso o design deixa de usar UNLOGGED (6.4).

## 6. Como funciona (decidido)

### 6.1 Agendamento — decidido com o usuário

- *Minha escolha (após revisão) — primeiro deploy:* se não existe nenhum `IngestRun` e as tabelas da Receita já têm dados, o processo registra um `SUCCESS` para o mês de `INGEST_MONTH` do `.env` de produção (obrigatório nesse caso; sem ele, loga erro e não dispara carga). Nada é apagado no deploy; a primeira recarga acontece só quando houver mês mais novo, no horário agendado.
- O serviço `ingest` vira processo de longa duração no `docker-compose.yml` (sai do `profiles: ['ingest']`, ganha `restart: unless-stopped`).
- Uma vez por dia, em horário de madrugada, verifica o WebDAV.
- *Minha escolha:* horário padrão 02:00 `America/Sao_Paulo`, configurável por env (`INGEST_CRON_HOUR`, `TZ`). Agendador interno ao processo Node (não depende do cron do host).
- Descoberta: PROPFIND `Depth: 1` na raiz `/public.php/webdav/`, filtra pastas no formato `AAAA-MM`, pega a maior. Se for maior que o último mês **concluído** registrado no banco → dispara carga. Se houver carga **em andamento** (mesmo mês), retoma.
- `INGEST_MONTH` deixa de ser obrigatório. *Minha escolha:* se definido, força aquele mês (uso manual/emergência). Manter um comando para disparar manualmente na hora (`npm run ingest:now` ou similar).

### 6.2 Estado da ingestão no banco — minha escolha

Substitui `temp/.progresso.json`. Novas tabelas Prisma (nomes indicativos):

- `IngestRun`: `id`, `month` (`AAAA-MM`), `status` (`RUNNING` | `SUCCESS` | `FAILED`), `startedAt`, `finishedAt`, `error`, `phase`/tabela atual.
- `IngestFile`: `runId`, `fileName`, `size`, `status` (`PENDING` | `INGESTED`), `rows`, `ingestedAt`. Chave única `(runId, fileName)`.

"Último mês carregado" = `IngestRun` mais recente com `SUCCESS`. "Em manutenção" = existe `IngestRun` com `RUNNING` (ou `FAILED` sem sucesso posterior — base está vazia/parcial).

### 6.3 Modo manutenção — decidido com o usuário (detalhes meus)

- Durante a carga a API responde manutenção. Decidido: pode ficar offline.
- *Minha escolha:* hook no Fastify retorna **HTTP 503** `{ "error": "Servidor em manutenção: atualização da base da Receita Federal em andamento.", "code": "maintenance" }` + `Retry-After`. Texto humano em `error`, porque é o campo que as respostas de erro já usam. Lê o estado do banco com cache em memória de ~30 s.
- *Minha escolha:* bloquear só rotas que leem dados da Receita (`/empresas/*`, `/consulta`, `/consulta/exportar`, `/cnaes/buscar`, `/municipios` e afins). Continuam abertas: `/health`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/user/credits`, `/consultas/minhas`, `/stripe/*` (webhook do Stripe não pode ficar horas fora).
- `/health` continua 200 e passa a incluir `{ maintenance: true|false }` (não pode falhar, senão o healthcheck do container marca unhealthy).
- Base em estado `FAILED` continua em manutenção até uma carga terminar com sucesso.

### 6.4 Fluxo da carga — disco e ordem

Ordem de grupos mantida (lookups → `Empresa` → `Simples` → `Estabelecimento` → `Socio`).

1. Criar/retomar `IngestRun` do mês; listar arquivos do mês e registrar `IngestFile` como `PENDING`.
2. Ativar manutenção (status `RUNNING` já ativa).
3. **Run novo (não retomada):** apagar conteúdo de `temp/` e `TRUNCATE` em todas as tabelas da Receita (`RESTART IDENTITY` para `Socio`). Truncate libera disco na hora — é a política "apaga o que está, coloca o novo".
4. Remover índices secundários das tabelas grandes antes de carregar (carga mais rápida, menos disco temporário); recriar ao final de cada grupo. Lista de índices: os de `CONFIGS[*].indexes` e os criados nas migrations para `Estabelecimento` (`Estabelecimento_uf_municipio_idx`, `Estabelecimento_uf_cnae_idx`, etc.). Chaves primárias ficam.
5. *Minha escolha (após revisão):* **abandonar UNLOGGED/LOGGED.** `SET LOGGED` reescreve a tabela inteira no WAL (~2× tamanho momentâneo) — incompatível com disco limitado — e UNLOGGED é esvaziada se o Postgres cair. Tabelas ficam LOGGED; carga mais lenta, aceito (duração não é problema). Remover também a lógica de UNLOGGED em `main()`.
6. **Um ZIP por vez:** baixar → checar integridade (tamanho) → extrair → apagar ZIP → ingerir CSV(s) → apagar CSV → marcar `IngestFile` `INGESTED` → próximo. Pico de disco ≈ banco + 1 ZIP + seu CSV.
7. Ingestão do CSV: staging + COPY como hoje, mas `INSERT ... SELECT` **sem** `ON CONFLICT DO NOTHING` silencioso — tabela está vazia, então conflito indica duplicata real na origem. *Minha escolha:* manter `ON CONFLICT DO NOTHING` só como proteção, mas registrar contagem de descartados no log/`IngestFile`. O `INSERT` final e a marcação `INGESTED` acontecem **na mesma transação**, para que crash entre os dois não duplique `Socio`.
8. Fim do grupo: checar disco antes de recriar índices (estimativa: `pg_relation_size` da tabela × 1,5 + margem; abortar com erro claro se faltar), recriar índices, `ANALYZE` da tabela.
9. Fim de tudo: `IngestRun` → `SUCCESS`, manutenção sai, e-mail de sucesso.

### 6.5 Retomada — decidido com o usuário (mecânica minha)

- **Download caído no meio:** retomar com `Range: bytes=<tamanhoLocal>-` (append no arquivo parcial). Se o servidor não suportar Range (sem 206), rebaixar o arquivo. Retry automático com backoff exponencial (*minha escolha:* até 5 tentativas por arquivo, 10 s → 5 min) para erro de rede, timeout, HTTP 5xx. Timeout de inatividade no socket para não travar para sempre.
- **Processo morreu (container reiniciou, servidor caiu):** ao subir, se existe `IngestRun` `RUNNING`, retoma: pula `IngestFile` já `INGESTED`, recomeça o arquivo em andamento.
- **Crash do Postgres:** como as tabelas ficam LOGGED (6.4.5), o que foi commitado sobrevive; retoma pelos `IngestFile`.
- *Minha escolha (após revisão):* **falha temporária** (rede, timeout, 5xx, Postgres indisponível) após esgotar retries do arquivo → `FAILED`, e-mail, e nova tentativa automática da mesma run a cada 30 min, sem esperar o dia seguinte (API não pode ficar ~23 h fora por um soluço de rede). E-mail de falha só na primeira falha e depois a cada 6 h enquanto persistir; e-mail de sucesso ao recuperar.
- **Falha permanente** (disco insuficiente, erro de parse/layout, HTTP 401/404): `FAILED`, e-mail, **não** tenta sozinho em loop; tenta de novo na verificação diária seguinte ou por `ingest:now` após correção.
- *Minha escolha:* se a run de M está `FAILED` e a Receita publica M+1, abandonar M e começar M+1 do zero (a base já está vazia; o mais novo vale mais).

### 6.6 Controle de disco — decidido com o usuário (mecânica minha)

- Antes de cada download: `fs.statfs` em `temp/`. Exigir livre ≥ `tamanhoZip × fator` + margem. *Minha escolha:* fator 6 (ZIP + CSV expandido ~4–5× + crescimento do banco) e margem `INGEST_MIN_FREE_GB` (padrão 5 GB), ambos configuráveis.
- Sem espaço → aborta com erro "espaço insuficiente: X GB livres, Y GB necessários para <arquivo>", `FAILED`, e-mail.
- Log de espaço livre a cada arquivo.
- Arquivos órfãos em `temp/` que não pertencem à run atual são apagados no início.

### 6.7 E-mail — decidido com o usuário

- Destinatário em `INGEST_NOTIFY_EMAIL` (*nome meu*; aceita vários separados por vírgula). Usa SMTP já configurado (`SMTP_*`, `SMTP_FROM`) — adicionar essas vars ao serviço `ingest` no compose.
- Sucesso: mês, duração, linhas por tabela.
- Falha: mês, fase/arquivo, erro, se vai retomar na próxima verificação, espaço em disco.
- *Minha escolha:* também e-mail ao **iniciar** a carga (avisa que a API entrou em manutenção).
- Falha no envio do e-mail não derruba a carga; só loga.

### 6.8 Aviso de base atualizada / cache defasado — decidido com o usuário (formato meu)

O cache (`ConsultaCache`) permanece. Ele guarda filtros + `total` e permite reexportar grátis por 30 dias; a reexportação roda na base atual, então o `total` salvo pode não bater.

- Novo endpoint `GET /base/status` (*minha escolha*): `{ month, loadedAt, maintenance }`.
- `GET /consultas/minhas` e histórico em `GET /user/credits`: cada item de cache ganha `baseDesatualizada: boolean` (`createdAt < loadedAt` do último `SUCCESS`) e `aviso` em texto quando true: "A base da Receita foi atualizada em <data> (mês <AAAA-MM>). Os números desta consulta podem estar defasados."
- **Cobrar a diferença — decidido com o usuário.** Em `/consulta/exportar` com cache válido: se `total` atual > `total` salvo, cobrar `ceil((totalAtual − totalSalvo) / 10)` créditos (mesma regra de preço de hoje), via `deductCredits` com descrição própria (ex.: "Diferença de exportação após atualização da base: +N registros"); sem saldo → mesma resposta de crédito insuficiente de hoje. Se `total` atual ≤ salvo → grátis, como hoje. Após cobrança, atualizar `total` do cache para o novo valor (o `expiresAt` não muda). Reembolso em falha de exportação segue o mesmo mecanismo existente. Endpoint de prévia (`/consulta`) deve informar o custo da diferença antes de exportar, se já informa o custo hoje.
- `/consulta` e `/consulta/exportar`: incluir `baseMes` / `baseAtualizadaEm` na resposta JSON e no nome ou primeira linha da planilha (*minha escolha*: aba/linha de rodapé com "Base Receita Federal: AAAA-MM").

### 6.9 Configuração nova (env)

| Var | Padrão | Uso |
|---|---|---|
| `INGEST_NOTIFY_EMAIL` | — | destinatário(s) dos e-mails |
| `INGEST_CRON_HOUR` | `2` | hora da verificação diária |
| `TZ` | `America/Sao_Paulo` | fuso do agendador |
| `INGEST_MONTH` | vazio | força mês específico (opcional) |
| `INGEST_MIN_FREE_GB` | `5` | margem mínima de disco |
| `INGEST_DISK_FACTOR` | `6` | multiplicador sobre tamanho do ZIP |

Atualizar `.env.example`.

## 7. Deixado para o implementador

- Biblioteca vs. agendador caseiro (preferir sem dependência nova: calcular próximo horário e `setTimeout`).
- Estrutura de arquivos (ex.: `src/ingest/scheduler.ts`, `run.ts`, `download.ts`, `load.ts`); manter `npm run download` / `npm run ingest` funcionando ou substituir por comandos equivalentes documentados.
- Formato exato dos logs e do HTML dos e-mails (seguir estilo de `email.service.ts`).
- Lock para impedir duas cargas simultâneas (ex.: `pg_advisory_lock`) — recomendado.
- Testes: unitários para descoberta de mês, cálculo de disco, retomada (decisão de refazer grupo), parsing PROPFIND; integração com Postgres para truncate/carga/transação de marcação, se viável.
- Migration Prisma das novas tabelas.

## 8. Fora de escopo, mas notado

- `STRIPE_SECRET_KEY` de teste está commitado em `.env.example` — revisar separadamente.
