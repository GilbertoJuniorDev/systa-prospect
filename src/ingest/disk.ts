import fs from 'fs';
import { IngestConfig } from './config';
import { DiskSpaceError } from './errors';

// ─── Espaço livre ────────────────────────────────────────────────────────────

export async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.promises.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

// ─── Requisitos ──────────────────────────────────────────────────────────────

export function requiredForZip(zipSize: number, cfg: Pick<IngestConfig, 'diskFactor' | 'minFreeBytes'>): number {
  return zipSize * cfg.diskFactor + cfg.minFreeBytes;
}

export function requiredForIndex(tableBytes: number, cfg: Pick<IngestConfig, 'minFreeBytes'>): number {
  return Math.ceil(tableBytes * 1.5) + cfg.minFreeBytes;
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

export function assertSpace(free: number, required: number, label: string): void {
  if (free < required) {
    throw new DiskSpaceError(`espaço insuficiente: ${gb(free)} GB livres, ${gb(required)} GB necessários para ${label}`);
  }
}
