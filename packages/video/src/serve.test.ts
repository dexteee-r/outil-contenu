import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange, startMediaServer, type MediaServer } from './serve';

describe('parseRange', () => {
  it('interprète les formes bytes=a-b, a-, -n et rejette l’invalide', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe('startMediaServer', () => {
  let dir: string;
  let server: MediaServer;
  let url: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-serve-'));
    fs.writeFileSync(path.join(dir, 'clip é.mp4'), Buffer.from('0123456789'));
    server = await startMediaServer();
    url = server.mount(path.join(dir, 'clip é.mp4'));
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sert le fichier entier avec le bon type et CORS', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toBe('0123456789');
  });

  it('répond 206 aux requêtes Range', async () => {
    const res = await fetch(url, { headers: { Range: 'bytes=2-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await res.text()).toBe('234');
  });

  it('renvoie la même URL pour le même fichier et 404 pour l’inconnu', async () => {
    expect(server.mount(path.join(dir, 'clip é.mp4'))).toBe(url);
    const res = await fetch(`${server.baseUrl}/media/99/x.mp4`);
    expect(res.status).toBe(404);
  });
});
