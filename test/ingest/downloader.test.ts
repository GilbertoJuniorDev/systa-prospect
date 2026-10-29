import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { downloadFile, redirectHeaders } from '../../src/ingest/downloader';
import { HttpError, PermanentError } from '../../src/ingest/errors';

const BUFFER = Buffer.alloc(1000);
for (let i = 0; i < BUFFER.length; i++) BUFFER[i] = i % 251;

type Mode = 'range' | 'ignore-range' | 'drop-first' | '503' | '404' | '416' | 'hang' | 'redirect' | 'bad-location';

let server: http.Server;
let baseUrl: string;
let mode: Mode;
let requests: http.IncomingHttpHeaders[];
let tmp: string;
let dest: string;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

function serveRange(req: http.IncomingMessage, res: http.ServerResponse, honor: boolean) {
  const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
  if (honor && m) {
    const start = Number(m[1]);
    res.writeHead(206, {
      'Content-Length': BUFFER.length - start,
      'Content-Range': `bytes ${start}-${BUFFER.length - 1}/${BUFFER.length}`,
    });
    res.end(BUFFER.subarray(start));
    return;
  }
  res.writeHead(200, { 'Content-Length': BUFFER.length });
  res.end(BUFFER);
}

beforeEach(async () => {
  sleeps.length = 0;
  requests = [];
  mode = 'range';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  dest = path.join(tmp, 'file.zip');
  server = http.createServer((req, res) => {
    requests.push(req.headers);
    if (req.url === '/target') return serveRange(req, res, true);
    switch (mode) {
      case 'range':
        return serveRange(req, res, true);
      case 'ignore-range':
        return serveRange(req, res, false);
      case 'drop-first':
        if (requests.length === 1) {
          res.writeHead(200, { 'Content-Length': BUFFER.length });
          res.write(BUFFER.subarray(0, 300));
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        return serveRange(req, res, true);
      case '503':
        res.writeHead(503);
        return res.end('busy');
      case '404':
        res.writeHead(404);
        return res.end('nope');
      case '416':
        if (req.headers.range) {
          res.writeHead(416);
          return res.end();
        }
        return serveRange(req, res, true);
      case 'hang':
        res.writeHead(200, { 'Content-Length': BUFFER.length });
        res.write(BUFFER.subarray(0, 10));
        return; // never ends
      case 'redirect':
        res.writeHead(302, { Location: '/target' });
        return res.end();
      case 'bad-location':
        res.writeHead(302, { Location: 'http://[bad' });
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = () => ({ url: `${baseUrl}/f`, dest, size: BUFFER.length, headers: { Authorization: 'Basic x' }, sleep });

describe('downloadFile', () => {
  it('downloads from scratch', async () => {
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].range).toBeUndefined();
    expect(requests[0].authorization).toBe('Basic x');
  });

  it('resumes with Range after drop', async () => {
    mode = 'drop-first';
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].range).toBe('bytes=300-');
    expect(sleeps).toEqual([10_000]);
  });

  it('resumes from a pre-existing partial file with 206', async () => {
    fs.writeFileSync(dest, BUFFER.subarray(0, 300));
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests[0].range).toBe('bytes=300-');
  });

  it('restarts when server ignores Range', async () => {
    mode = 'ignore-range';
    fs.writeFileSync(dest, BUFFER.subarray(0, 300));
    await downloadFile(base());
    expect(fs.readFileSync(dest).length).toBe(1000);
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
  });

  it('skips when local size equals remote', async () => {
    fs.writeFileSync(dest, BUFFER);
    await downloadFile(base());
    expect(requests).toHaveLength(0);
  });

  it('deletes and restarts when local is larger than remote', async () => {
    fs.writeFileSync(dest, Buffer.alloc(1500, 7));
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests[0].range).toBeUndefined();
  });

  it('on 416 deletes the partial and restarts within the same attempt', async () => {
    mode = '416';
    fs.writeFileSync(dest, BUFFER.subarray(0, 300));
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].range).toBeUndefined();
    expect(sleeps).toEqual([]);
  });

  it('follows redirects', async () => {
    mode = 'redirect';
    await downloadFile(base());
    expect(fs.readFileSync(dest).equals(BUFFER)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('gives up after maxAttempts on 503', async () => {
    mode = '503';
    await expect(downloadFile(base())).rejects.toMatchObject({ name: 'HttpError', status: 503 });
    expect(requests).toHaveLength(5);
    expect(sleeps).toEqual([10_000, 20_000, 40_000, 80_000]);
  });

  it('caps backoff at 300s', async () => {
    mode = '503';
    await expect(downloadFile({ ...base(), maxAttempts: 9 })).rejects.toBeInstanceOf(HttpError);
    expect(sleeps).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });

  it('fails immediately on 404', async () => {
    mode = '404';
    await expect(downloadFile(base())).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('times out on socket inactivity with ETIMEDOUT', async () => {
    mode = 'hang';
    await expect(downloadFile({ ...base(), idleTimeoutMs: 100, maxAttempts: 2 })).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(requests).toHaveLength(2);
  });

  it('invalid Location header rejects with PermanentError (no retry)', async () => {
    mode = 'bad-location';
    const err = await downloadFile(base()).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('Location inválido');
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe('redirectHeaders', () => {
  const headers = { Authorization: 'Basic x', Range: 'bytes=10-' };

  it('keeps Authorization on same protocol and host', () => {
    expect(redirectHeaders(new URL('https://a.gov.br/x'), new URL('https://a.gov.br/y'), headers)).toEqual(headers);
  });

  it('strips Authorization when the host changes', () => {
    expect(redirectHeaders(new URL('https://a.gov.br/x'), new URL('https://cdn.example/y'), headers)).toEqual({
      Range: 'bytes=10-',
    });
  });

  it('strips Authorization when only the protocol changes (https → http)', () => {
    expect(redirectHeaders(new URL('https://a.gov.br/x'), new URL('http://a.gov.br/y'), headers)).toEqual({
      Range: 'bytes=10-',
    });
  });

  it('strips authorization regardless of header case', () => {
    expect(redirectHeaders(new URL('https://a/x'), new URL('http://a/x'), { authorization: 'b' })).toEqual({});
  });
});
