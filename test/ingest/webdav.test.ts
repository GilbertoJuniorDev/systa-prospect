import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePropfind, davAuthHeader, davMonthUrl, DAV_HOST } from '../../src/ingest/webdav';
import type { IngestConfig } from '../../src/ingest/config';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
const root = fixture('propfind-root.xml');
const month = fixture('propfind-month.xml');

describe('parsePropfind', () => {
  it('lista os diretórios da raiz, sem a própria pasta consultada', () => {
    expect(parsePropfind(root).filter((e) => e.isDir).map((e) => e.name)).toEqual(['2026-09', '2026-10']);
  });

  it('inclui arquivo solto da raiz com nome decodificado', () => {
    const file = parsePropfind(root).find((e) => !e.isDir);
    expect(file).toMatchObject({ name: 'LEIA-ME Receita.txt', size: 2048, isDir: false });
    expect(file?.href).toBe('/public.php/webdav/LEIA-ME Receita.txt');
  });

  it('diretórios têm size null', () => {
    expect(parsePropfind(root).filter((e) => e.isDir).every((e) => e.size === null)).toBe(true);
  });

  it('lista os arquivos do mês com tamanho', () => {
    const entries = parsePropfind(month);
    expect(entries.map((e) => e.name)).toEqual(['Empresas0.zip', 'Socios3.zip', 'LAYOUT.pdf']);
    expect(entries.find((e) => e.name === 'Empresas0.zip')).toMatchObject({
      size: 123,
      isDir: false,
      href: '/public.php/webdav/2026-10/Empresas0.zip',
    });
    expect(entries.find((e) => e.name === 'Socios3.zip')?.size).toBe(456789);
  });

  it('retorna lista vazia para XML sem respostas', () => {
    expect(parsePropfind('<d:multistatus xmlns:d="DAV:"></d:multistatus>')).toEqual([]);
  });
});

describe('helpers WebDAV', () => {
  const cfg = { shareToken: 'abc123' } as IngestConfig;

  it('davAuthHeader gera Basic com token e senha vazia', () => {
    expect(davAuthHeader(cfg)).toBe(`Basic ${Buffer.from('abc123:').toString('base64')}`);
  });

  it('davMonthUrl termina com /', () => {
    expect(DAV_HOST).toBe('arquivos.receitafederal.gov.br');
    expect(davMonthUrl('2026-10')).toBe('https://arquivos.receitafederal.gov.br/public.php/webdav/2026-10/');
  });
});
