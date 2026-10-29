import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import iconv from 'iconv-lite';
import type { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { executeRun, extractZip, type RunDeps } from '../../src/ingest/run';
import { connect, buildIndexes } from '../../src/ingest/db';
import { loadCsv } from '../../src/ingest/loader';
import { RECEITA_TABLES, SECONDARY_INDEXES } from '../../src/ingest/tables';
import { createRun, registerFiles } from '../../src/ingest/state';
import { HttpError } from '../../src/ingest/errors';
import type { IngestConfig } from '../../src/ingest/config';
import type { DavEntry } from '../../src/ingest/webdav';
import type { DownloadOptions } from '../../src/ingest/downloader';
import type { Notifier } from '../../src/ingest/notify';

const url = process.env.TEST_DATABASE_URL;
const MONTH = '2026-10';
const ZIP_SIZE = 100;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES: Record<string, { csv: string; lines: string[] }> = {
  'Cnaes.zip': {
    csv: 'F.K03200$Z.D30513.CNAECSV',
    lines: ['"0111301";"Cultivo de arroz"', '"0111302";"Cultivo de milho"'],
  },
  'Empresas0.zip': {
    csv: 'K3241.K03200Y0.D30513.EMPRECSV',
    lines: [
      '"11111111";"EMPRESA UM";"2062";"49";"1000,50";"01";""',
      '"22222222";"EMPRESA DOIS";"2062";"49";"0,00";"03";""',
    ],
  },
  'Socios0.zip': {
    csv: 'K3241.K03200Y0.D30513.SOCIOCSV',
    lines: [
      '"11111111";"2";"JOÃO DA SILVA";"***123456**";"49";"20200101";"";"";"";"00";"3"',
      '"11111111";"2";"MARIA AÇUCENA";"***654321**";"49";"20200102";"";"";"";"00";"4"',
      '"22222222";"2";"JOSÉ";"***111111**";"22";"20200103";"";"";"";"00";"5"',
    ],
  },
};

function entry(name: string, size = ZIP_SIZE): DavEntry {
  return { name, href: `/public.php/webdav/${MONTH}/${name}`, size, isDir: false };
}

const DEFAULT_LISTING = [entry('Socios0.zip'), entry('Empresas0.zip'), entry('Cnaes.zip')];

function writeWin1252(file: string, lines: string[]): void {
  fs.writeFileSync(file, iconv.encode(lines.join('\n') + '\n', 'win1252'));
}

// ─── ZIP "stored" mínimo (para testar o extractZip real) ─────────────────────

function storedZip(name: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = zlib.crc32(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const localPart = Buffer.concat([local, nameBuf, content]);
  const centralPart = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, end]);
}

describe('extractZip', () => {
  it('extracts files and returns absolute paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-unzip-'));
    try {
      const zip = path.join(dir, 'Cnaes.zip');
      fs.writeFileSync(zip, storedZip('F.K03200$Z.D30513.CNAECSV', Buffer.from('"1";"a"\n')));
      const dest = path.join(dir, 'out');

      const files = await extractZip(zip, dest);

      expect(files).toEqual([path.join(dest, 'F.K03200$Z.D30513.CNAECSV')]);
      expect(path.isAbsolute(files[0])).toBe(true);
      expect(fs.readFileSync(files[0], 'utf8')).toBe('"1";"a"\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Orquestrador (integração) ───────────────────────────────────────────────

describe.skipIf(!url)('executeRun (integração)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  let db: Client;
  let tempDir: string;
  let logs: string[];

  let downloads: string[];
  let loadedTables: string[];
  let notes: { started: string[]; succeeded: any[]; failed: any[] };

  const silent = () => {};

  async function cleanTables() {
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${RECEITA_TABLES.map((t) => `"${t}"`).join(', ')}, "IngestRun" CASCADE`,
    );
  }

  async function count(table: string): Promise<number> {
    const r = await db.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return r.rows[0].n;
  }

  async function indexNames(): Promise<string[]> {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    return r.rows.map((x) => x.indexname);
  }

  async function insertEmpresa(cnpj: string) {
    await db.query(
      `INSERT INTO "Empresa" (cnpj_base, razao_social, natureza_juridica, qualificacao_resp, capital_social, porte)
       VALUES ($1, 'PRE', '2062', '49', 0, '01')`,
      [cnpj],
    );
  }

  function makeCfg(): IngestConfig {
    return {
      shareToken: 'tok',
      tempDir,
      cronHour: 2,
      timeZone: 'America/Sao_Paulo',
      bootstrapMonth: null,
      minFreeBytes: 0,
      diskFactor: 6,
      notifyEmails: [],
      databaseUrl: url!,
    };
  }

  const fakeDownload = async (opts: DownloadOptions) => {
    downloads.push(path.basename(opts.dest));
    fs.writeFileSync(opts.dest, Buffer.alloc(opts.size));
  };

  const fakeExtract = async (zip: string, destDir: string) => {
    const fx = FIXTURES[path.basename(zip)];
    fs.mkdirSync(destDir, { recursive: true });
    const file = path.join(destDir, fx.csv);
    writeWin1252(file, fx.lines);
    return [file];
  };

  const fakeNotifier: Notifier = {
    async started(month) {
      notes.started.push(month);
    },
    async succeeded(r) {
      notes.succeeded.push(r);
    },
    async failed(r) {
      notes.failed.push(r);
    },
  };

  function makeDeps(over: Partial<RunDeps> = {}): RunDeps {
    return {
      cfg: makeCfg(),
      prisma,
      db,
      listMonthFiles: async () => DEFAULT_LISTING,
      downloadFile: fakeDownload,
      extractZip: fakeExtract,
      loadCsv: async (client, csv, config) => {
        loadedTables.push(config.tabela);
        return loadCsv(client, csv, config);
      },
      freeBytes: async () => 1e15,
      notifier: fakeNotifier,
      log: (m) => logs.push(m),
      ...over,
    };
  }

  async function getRun(id: string) {
    return prisma.ingestRun.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(async () => {
    db = await connect(url!);
  });

  beforeEach(async () => {
    await cleanTables();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
    logs = [];
    downloads = [];
    loadedTables = [];
    notes = { started: [], succeeded: [], failed: [] };
  });

  afterAll(async () => {
    await cleanTables();
    for (const table of Object.keys(SECONDARY_INDEXES)) {
      await buildIndexes(db, table, { minFreeBytes: 0 }, os.tmpdir(), silent);
    }
    await db.end();
    await prisma.$disconnect();
  });

  it('fresh run truncates, loads in TABLE_ORDER, marks SUCCESS', async () => {
    await insertEmpresa('99999999');
    fs.writeFileSync(path.join(tempDir, 'lixo-antigo.txt'), 'x');
    const runId = await createRun(prisma, MONTH);

    await executeRun(runId, makeDeps());

    const run = await getRun(runId);
    expect(run.status).toBe('SUCCESS');
    expect(run.prepared).toBe(true);
    expect(loadedTables).toEqual(['Cnae', 'Empresa', 'Socio']);
    expect(await count('Empresa')).toBe(2);
    const pre = await db.query(`SELECT 1 FROM "Empresa" WHERE cnpj_base = '99999999'`);
    expect(pre.rowCount).toBe(0);
    expect(await count('Socio')).toBe(3);
    expect(await count('Cnae')).toBe(2);

    const files = await prisma.ingestFile.findMany({ where: { runId } });
    expect(files.every((f) => f.status === 'INGESTED')).toBe(true);
    expect(files.find((f) => f.fileName === 'Socios0.zip')?.rows).toBe(3);

    expect(notes.started).toEqual([MONTH]);
    expect(notes.succeeded).toHaveLength(1);
    expect(notes.succeeded[0]).toMatchObject({
      month: MONTH,
      recovered: false,
      rowsByTable: { Cnae: 2, Empresa: 2, Socio: 3 },
    });
    expect(notes.failed).toHaveLength(0);

    expect(fs.existsSync(tempDir)).toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual([]);

    const idx = await indexNames();
    for (const list of Object.values(SECONDARY_INDEXES)) {
      for (const i of list) expect(idx).toContain(i.name);
    }
  });

  it('resume skips INGESTED and does not truncate', async () => {
    const runId = await createRun(prisma, MONTH);
    await prisma.ingestRun.update({ where: { id: runId }, data: { prepared: true } });
    await registerFiles(prisma, runId, DEFAULT_LISTING);
    await prisma.ingestFile.updateMany({
      where: { runId, fileName: 'Empresas0.zip' },
      data: { status: 'INGESTED', rows: 1, discarded: 0 },
    });
    await insertEmpresa('99999999');

    // Parcial de ZIP pendente é mantido (retomada por Range); o resto é órfão.
    fs.writeFileSync(path.join(tempDir, 'Socios0.zip'), Buffer.alloc(10));
    fs.writeFileSync(path.join(tempDir, 'lixo.txt'), 'x');
    fs.mkdirSync(path.join(tempDir, 'run-velho'));
    let seenAtDownload: string[] = [];
    const download = async (opts: DownloadOptions) => {
      if (path.basename(opts.dest) === 'Socios0.zip') {
        seenAtDownload = fs.readdirSync(tempDir);
        expect(fs.statSync(opts.dest).size).toBe(10);
      }
      await fakeDownload(opts);
    };

    await executeRun(runId, makeDeps({ downloadFile: download }));

    const run = await getRun(runId);
    expect(run.status).toBe('SUCCESS');
    expect(downloads).not.toContain('Empresas0.zip');
    expect(downloads.sort()).toEqual(['Cnaes.zip', 'Socios0.zip']);
    expect(await count('Empresa')).toBe(1);
    expect(await count('Socio')).toBe(3);
    expect(notes.started).toEqual([]);
    expect(seenAtDownload).not.toContain('lixo.txt');
    expect(seenAtDownload).not.toContain('run-velho');
  });

  it('skips unknown zip', async () => {
    const runId = await createRun(prisma, MONTH);
    const listing = [...DEFAULT_LISTING, entry('LAYOUT.pdf'), entry('Novidade.zip')];

    await executeRun(runId, makeDeps({ listMonthFiles: async () => listing }));

    expect((await getRun(runId)).status).toBe('SUCCESS');
    expect(downloads).not.toContain('LAYOUT.pdf');
    expect(downloads).not.toContain('Novidade.zip');
    const skipped = await prisma.ingestFile.findMany({ where: { runId, status: 'SKIPPED' } });
    expect(skipped.map((f) => f.fileName).sort()).toEqual(['LAYOUT.pdf', 'Novidade.zip']);
  });

  it('crash mid-load does not duplicate Socio', async () => {
    const runId = await createRun(prisma, MONTH);
    let crashed = false;
    const crashingLoad: RunDeps['loadCsv'] = async (client, csv, config) => {
      const r = await loadCsv(client, csv, config);
      if (config.tabela === 'Socio' && !crashed) {
        crashed = true;
        throw new Error('conexão caiu no meio da carga');
      }
      return r;
    };

    await executeRun(runId, makeDeps({ loadCsv: crashingLoad }));

    let run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.error).toBe('conexão caiu no meio da carga');
    expect(run.phase).toBe('Socio: Socios0.zip');
    expect(await count('Socio')).toBe(0);
    const socioFile = await prisma.ingestFile.findFirstOrThrow({ where: { runId, fileName: 'Socios0.zip' } });
    expect(socioFile.status).toBe('PENDING');
    // ZIP só é apagado após o COMMIT.
    expect(fs.existsSync(path.join(tempDir, 'Socios0.zip'))).toBe(true);
    expect(notes.failed).toHaveLength(1);
    expect(notes.failed[0]).toMatchObject({ month: MONTH, phase: 'Socio: Socios0.zip', kind: 'PERMANENT' });

    downloads = [];
    await executeRun(runId, makeDeps({ loadCsv: crashingLoad }));

    run = await getRun(runId);
    expect(run.status).toBe('SUCCESS');
    expect(await count('Socio')).toBe(FIXTURES['Socios0.zip'].lines.length);
    expect(await count('Empresa')).toBe(2);
    expect(downloads).toEqual(['Socios0.zip']);
    expect(notes.started).toEqual([MONTH]);
    expect(notes.succeeded[0].recovered).toBe(true);
  });

  it('disk check fails permanently', async () => {
    const runId = await createRun(prisma, MONTH);

    await executeRun(runId, makeDeps({ freeBytes: async () => 1 }));

    const run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.errorKind).toBe('PERMANENT');
    expect(run.error?.startsWith('espaço insuficiente')).toBe(true);
    expect(run.error).toContain('Cnaes.zip');
    expect(downloads).toEqual([]);
    expect(notes.failed).toHaveLength(1);
    expect(notes.failed[0]).toMatchObject({ kind: 'PERMANENT', freeBytes: 1 });
  });

  it('skips disk check when the zip is already complete on disk', async () => {
    const runId = await createRun(prisma, MONTH);
    await prisma.ingestRun.update({ where: { id: runId }, data: { prepared: true } });
    fs.writeFileSync(path.join(tempDir, 'Cnaes.zip'), Buffer.alloc(ZIP_SIZE));
    const freeBytes = async () => 1;

    await executeRun(
      runId,
      makeDeps({ freeBytes, listMonthFiles: async () => [entry('Cnaes.zip')] }),
    );

    expect((await getRun(runId)).status).toBe('SUCCESS');
    expect(await count('Cnae')).toBe(2);
  });

  it('temporary error emails once in 6h', async () => {
    const runId = await createRun(prisma, MONTH);
    const failing = async () => {
      throw new HttpError(503, 'HTTP 503 ao baixar');
    };

    await executeRun(runId, makeDeps({ downloadFile: failing }));
    let run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.errorKind).toBe('TEMPORARY');

    await executeRun(runId, makeDeps({ downloadFile: failing }));
    run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.errorKind).toBe('TEMPORARY');

    expect(notes.failed).toHaveLength(1);
    expect(notes.failed[0]).toMatchObject({ kind: 'TEMPORARY', error: 'HTTP 503 ao baixar' });
    expect(notes.started).toEqual([MONTH]);
  });

  it('unexpected csv inside zip is permanent', async () => {
    const runId = await createRun(prisma, MONTH);
    const extract = async (zip: string, destDir: string) => {
      if (path.basename(zip) !== 'Empresas0.zip') return fakeExtract(zip, destDir);
      fs.mkdirSync(destDir, { recursive: true });
      const file = path.join(destDir, FIXTURES['Socios0.zip'].csv);
      writeWin1252(file, FIXTURES['Socios0.zip'].lines);
      return [file];
    };

    await executeRun(runId, makeDeps({ extractZip: extract }));

    const run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.errorKind).toBe('PERMANENT');
    expect(run.error).toBe(`arquivo inesperado ${FIXTURES['Socios0.zip'].csv} em Empresas0.zip`);
    expect(await count('Socio')).toBe(0);
    expect(await count('Empresa')).toBe(0);
    expect(loadedTables).toEqual(['Cnae']);
  });

  it('fails when the month has no Receita zip', async () => {
    const runId = await createRun(prisma, MONTH);

    await executeRun(runId, makeDeps({ listMonthFiles: async () => [entry('LAYOUT.pdf')] }));

    const run = await getRun(runId);
    expect(run.status).toBe('FAILED');
    expect(run.errorKind).toBe('PERMANENT');
  });

  it('never rejects, even when the failure path fails', async () => {
    await expect(executeRun('run-inexistente', makeDeps())).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });
});
