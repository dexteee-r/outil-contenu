import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpGet } from '@outil/core';
import { startInspirationServer } from './inspiration-server.js';

let dir: string;
let server: http.Server;
let base: string;

/** Faux YouTube : oEmbed + une miniature maxres de 5 Ko. */
const fakeYoutube: HttpGet = (url) => {
  if (url.includes('/oembed')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ title: 'Titre test', author_name: 'Chaîne test' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }
  const ok = url.endsWith('/maxresdefault.jpg');
  return Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.reject(new Error('binaire')),
    arrayBuffer: () => Promise.resolve(new Uint8Array(ok ? 5000 : 0).buffer),
  });
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-inspi-srv-'));
  fs.mkdirSync(path.join(dir, 'tcg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tcg', 'account.yaml'), 'slug: tcg');
  const started = await startInspirationServer({ accountsDir: dir, port: 0, httpGet: fakeYoutube });
  server = started.server;
  base = started.url;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('page web d’inspiration', () => {
  it('sert la page et la liste des comptes', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Miniatures d'inspiration");
    expect(await (await fetch(`${base}/api/accounts`)).json()).toEqual({ accounts: ['tcg'] });
  });

  it('refuse un compte inconnu', async () => {
    const res = await fetch(`${base}/api/images?account=pirate`);
    expect(res.status).toBe(400);
  });

  it('récupère une miniature YouTube dans le dossier du compte et la liste', async () => {
    const res = await fetch(`${base}/api/youtube?account=tcg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://youtu.be/dQw4w9WgXcQ', 'pas un lien'] }),
    });
    const { results } = (await res.json()) as { results: { ok: boolean }[] };
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    const files = fs.readdirSync(path.join(dir, 'tcg', 'inspiration'));
    expect(files).toContain('chaine-test-titre-test-dQw4w9WgXcQ-16x9.jpg');
    const list = (await (await fetch(`${base}/api/images?account=tcg`)).json()) as {
      images: { name: string }[];
    };
    expect(list.images.map((i) => i.name)).toContain('chaine-test-titre-test-dQw4w9WgXcQ-16x9.jpg');
  });

  it('enregistre une capture déposée, la sert, puis la supprime', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const up = await fetch(`${base}/api/upload?account=tcg&name=tiktok.png`, {
      method: 'POST',
      body: new Uint8Array(png),
    });
    expect(await up.json()).toEqual({ name: 'tiktok.png' });
    const img = await fetch(`${base}/image?account=tcg&name=tiktok.png`);
    expect(img.headers.get('content-type')).toBe('image/png');
    const del = await fetch(`${base}/api/images?account=tcg&name=tiktok.png`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'tcg', 'inspiration', 'tiktok.png'))).toBe(false);
  });

  it('ne sert ni ne supprime rien hors du dossier d’inspiration', async () => {
    expect((await fetch(`${base}/image?account=tcg&name=..%2Faccount.yaml`)).status).toBe(404);
    const del = await fetch(`${base}/api/images?account=tcg&name=..%2Faccount.yaml`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(400);
    expect(fs.existsSync(path.join(dir, 'tcg', 'account.yaml'))).toBe(true);
  });
});
