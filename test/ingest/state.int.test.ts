import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  getLastSuccess,
  getOpenRun,
  createRun,
  abandonRun,
  markRunning,
  markPrepared,
  setPhase,
  markSuccess,
  markFailed,
  registerFiles,
  pendingFiles,
  bootstrapIfNeeded,
  latestRunStatus,
  MARK_INGESTED_SQL,
} from '../../src/ingest/state';
import { PermanentError } from '../../src/ingest/errors';
import type { IngestConfig } from '../../src/ingest/config';

const url = process.env.TEST_DATABASE_URL;

const baseCfg = { bootstrapMonth: null } as IngestConfig;
const silent = () => {};

const empresa = {
  cnpj_base: '00000000',
  razao_social: 'X',
  natureza_juridica: '2062',
  qualificacao_resp: '49',
  capital_social: 0,
  porte: '01',
};

describe.skipIf(!url)('ingest state (integração)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "IngestRun" CASCADE');
    await prisma.$executeRawUnsafe('TRUNCATE "Empresa"');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('open run hidden after later success', async () => {
    const failed = await createRun(prisma, '2026-09');
    await markFailed(prisma, failed, 'boom', 'TEMPORARY');
    expect((await getOpenRun(prisma))?.id).toBe(failed);

    const ok = await createRun(prisma, '2026-10');
    await markSuccess(prisma, ok);
    expect(await getOpenRun(prisma)).toBeNull();
    expect((await getLastSuccess(prisma))?.month).toBe('2026-10');
  });

  it('getOpenRun maps row and ignores ABANDONED', async () => {
    const id = await createRun(prisma, '2026-09');
    await markFailed(prisma, id, 'x', 'PERMANENT');
    expect(await getOpenRun(prisma)).toMatchObject({
      id,
      month: '2026-09',
      status: 'FAILED',
      errorKind: 'PERMANENT',
    });
    await abandonRun(prisma, id);
    expect(await getOpenRun(prisma)).toBeNull();
  });

  it('markRunning clears finishedAt; markSuccess clears error', async () => {
    const id = await createRun(prisma, '2026-09');
    await markFailed(prisma, id, 'x', 'TEMPORARY');
    await markRunning(prisma, id);
    let row = await prisma.ingestRun.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('RUNNING');
    expect(row.finishedAt).toBeNull();
    await markPrepared(prisma, id);
    await setPhase(prisma, id, 'carga');
    await markSuccess(prisma, id);
    row = await prisma.ingestRun.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'SUCCESS', prepared: true, phase: 'carga', error: null, errorKind: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('markFailed throttles e-mail 6h', async () => {
    const id = await createRun(prisma, '2026-09');
    expect(await markFailed(prisma, id, 'e1', 'TEMPORARY')).toEqual({ shouldEmail: true });
    expect(await markFailed(prisma, id, 'e2', 'TEMPORARY')).toEqual({ shouldEmail: false });
    await prisma.ingestRun.update({
      where: { id },
      data: { lastFailureEmailAt: new Date(Date.now() - 7 * 3600 * 1000) },
    });
    expect(await markFailed(prisma, id, 'e3', 'TEMPORARY')).toEqual({ shouldEmail: true });
    const row = await prisma.ingestRun.findUniqueOrThrow({ where: { id } });
    expect(row.error).toBe('e3');
    expect(Date.now() - row.lastFailureEmailAt!.getTime()).toBeLessThan(60_000);
  });

  it('registerFiles marks unknown as SKIPPED', async () => {
    const id = await createRun(prisma, '2026-10');
    await registerFiles(prisma, id, [
      { name: 'Empresas0.zip', href: '/a', size: 100, isDir: false },
      { name: 'LAYOUT.pdf', href: '/b', size: 5, isDir: false },
      { name: 'sub', href: '/c', size: null, isDir: true },
      { name: 'Socios0.zip', href: '/d', size: null, isDir: false },
    ]);
    const files = await prisma.ingestFile.findMany({ where: { runId: id }, orderBy: { fileName: 'asc' } });
    expect(files.map((f) => [f.fileName, f.status, f.tableName])).toEqual([
      ['Empresas0.zip', 'PENDING', 'Empresa'],
      ['LAYOUT.pdf', 'SKIPPED', null],
    ]);
    expect(await pendingFiles(prisma, id)).toEqual([
      { fileName: 'Empresas0.zip', size: 100, tableName: 'Empresa' },
    ]);
  });

  it('pendingFiles ordered by fileName and excludes INGESTED', async () => {
    const id = await createRun(prisma, '2026-10');
    await registerFiles(prisma, id, [
      { name: 'Socios1.zip', href: '/a', size: 10, isDir: false },
      { name: 'Empresas0.zip', href: '/b', size: 20, isDir: false },
      { name: 'Cnaes.zip', href: '/c', size: 30, isDir: false },
    ]);
    await prisma.ingestFile.updateMany({ where: { runId: id, fileName: 'Cnaes.zip' }, data: { status: 'INGESTED' } });
    const p = await pendingFiles(prisma, id);
    expect(p.map((f) => f.fileName)).toEqual(['Empresas0.zip', 'Socios1.zip']);
    expect(typeof p[0].size).toBe('number');
  });

  it('registerFiles idempotent', async () => {
    const id = await createRun(prisma, '2026-10');
    const entries = [
      { name: 'Empresas0.zip', href: '/a', size: 100, isDir: false },
      { name: 'LAYOUT.pdf', href: '/b', size: 5, isDir: false },
    ];
    await registerFiles(prisma, id, entries);
    await prisma.ingestFile.updateMany({ where: { runId: id, fileName: 'Empresas0.zip' }, data: { status: 'INGESTED' } });
    await registerFiles(prisma, id, entries);
    const files = await prisma.ingestFile.findMany({ where: { runId: id } });
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.fileName === 'Empresas0.zip')?.status).toBe('INGESTED');
    expect(await pendingFiles(prisma, id)).toEqual([]);
  });

  it('registerFiles refreshes size of PENDING rows from the new listing (INGESTED untouched)', async () => {
    const id = await createRun(prisma, '2026-10');
    await registerFiles(prisma, id, [
      { name: 'Empresas0.zip', href: '/a', size: 100, isDir: false },
      { name: 'Socios0.zip', href: '/b', size: 50, isDir: false },
    ]);
    await prisma.ingestFile.updateMany({ where: { runId: id, fileName: 'Socios0.zip' }, data: { status: 'INGESTED' } });

    await registerFiles(prisma, id, [
      { name: 'Empresas0.zip', href: '/a', size: 120, isDir: false },
      { name: 'Socios0.zip', href: '/b', size: 70, isDir: false },
    ]);

    expect(await pendingFiles(prisma, id)).toEqual([{ fileName: 'Empresas0.zip', size: 120, tableName: 'Empresa' }]);
    const socio = await prisma.ingestFile.findFirstOrThrow({ where: { runId: id, fileName: 'Socios0.zip' } });
    expect(Number(socio.size)).toBe(50);
  });

  it('MARK_INGESTED_SQL updates file', async () => {
    const id = await createRun(prisma, '2026-10');
    await registerFiles(prisma, id, [{ name: 'Empresas0.zip', href: '/a', size: 100, isDir: false }]);
    await prisma.$executeRawUnsafe(MARK_INGESTED_SQL, id, 'Empresas0.zip', 7, 2);
    const f = await prisma.ingestFile.findFirstOrThrow({ where: { runId: id } });
    expect(f).toMatchObject({ status: 'INGESTED', rows: 7, discarded: 2 });
    expect(f.ingestedAt).toBeInstanceOf(Date);
  });

  it('bootstrap records SUCCESS when base has data', async () => {
    await prisma.empresa.create({ data: empresa });
    await bootstrapIfNeeded(prisma, { ...baseCfg, bootstrapMonth: '2026-06' }, silent);
    expect((await getLastSuccess(prisma))?.month).toBe('2026-06');
    const run = await prisma.ingestRun.findFirstOrThrow();
    expect(run.prepared).toBe(true);
    // idempotente
    await bootstrapIfNeeded(prisma, { ...baseCfg, bootstrapMonth: '2026-06' }, silent);
    expect(await prisma.ingestRun.count()).toBe(1);
  });

  it('bootstrap without INGEST_MONTH throws PermanentError when base has data', async () => {
    await prisma.empresa.create({ data: empresa });
    const logs: string[] = [];
    await expect(bootstrapIfNeeded(prisma, baseCfg, (m) => logs.push(m))).rejects.toBeInstanceOf(PermanentError);
    expect(logs).toEqual(['INGEST_MONTH obrigatório no primeiro deploy com base já carregada']);
    expect(await prisma.ingestRun.count()).toBe(0);
  });

  it('bootstrap no-op when tables empty', async () => {
    await bootstrapIfNeeded(prisma, { ...baseCfg, bootstrapMonth: '2026-06' }, silent);
    expect(await prisma.ingestRun.count()).toBe(0);
  });

  it('latestRunStatus', async () => {
    expect(await latestRunStatus(prisma)).toEqual({ month: null, loadedAt: null, maintenance: false });
    const ok = await createRun(prisma, '2026-09');
    await markSuccess(prisma, ok);
    const s1 = await latestRunStatus(prisma);
    expect(s1.month).toBe('2026-09');
    expect(s1.loadedAt).toBeInstanceOf(Date);
    expect(s1.maintenance).toBe(false);
    await createRun(prisma, '2026-10');
    expect((await latestRunStatus(prisma)).maintenance).toBe(true);
  });

  it('bootstrap SUCCESS has phase bootstrap and no loadedAt (caches are not flagged stale)', async () => {
    await prisma.empresa.create({ data: empresa });
    await bootstrapIfNeeded(prisma, { ...baseCfg, bootstrapMonth: '2026-06' }, silent);
    const run = await prisma.ingestRun.findFirstOrThrow();
    expect(run.phase).toBe('bootstrap');
    expect(await latestRunStatus(prisma)).toEqual({ month: '2026-06', loadedAt: null, maintenance: false });

    // Primeira carga real depois do bootstrap: loadedAt volta a valer.
    const ok = await createRun(prisma, '2026-07');
    await markSuccess(prisma, ok);
    const s = await latestRunStatus(prisma);
    expect(s.month).toBe('2026-07');
    expect(s.loadedAt).toBeInstanceOf(Date);
  });
});
