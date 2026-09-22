import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadYoutubeThumbnails,
  isShortsUrl,
  parseYoutubeId,
  slugForFile,
  thumbnailVariants,
  type HttpGet,
} from './youtube.js';

describe('parseYoutubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/aBcDeFgHiJk', 'aBcDeFgHiJk'],
    ['https://m.youtube.com/shorts/aBcDeFgHiJk?feature=share', 'aBcDeFgHiJk'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('%s → %s', (input, id) => {
    expect(parseYoutubeId(input)).toBe(id);
  });

  it('refuse ce qui n’est pas un lien de vidéo YouTube', () => {
    expect(parseYoutubeId('https://www.tiktok.com/@x/video/123')).toBeNull();
    expect(parseYoutubeId('https://www.youtube.com/@chaine')).toBeNull();
    expect(parseYoutubeId('pas un lien')).toBeNull();
  });

  it('reconnaît les Shorts', () => {
    expect(isShortsUrl('https://www.youtube.com/shorts/aBcDeFgHiJk')).toBe(true);
    expect(isShortsUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
  });
});

describe('slugForFile / thumbnailVariants', () => {
  it('produit un nom de fichier sûr sous Windows', () => {
    expect(slugForFile('PokéRev: J’ouvre 36 boosters !?', 'abc12345678')).toBe(
      'pokerev-j-ouvre-36-boosters-abc12345678',
    );
    expect(slugForFile(null, 'abc12345678')).toBe('abc12345678');
  });

  it('essaie la verticale puis le 16:9 du meilleur au moins bon', () => {
    expect(thumbnailVariants('X').map((v) => v.name)).toEqual([
      'oardefault',
      'maxresdefault',
      'sddefault',
      'hqdefault',
    ]);
  });
});

describe('downloadYoutubeThumbnails', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Faux YouTube : oEmbed + variantes disponibles ou 404. */
  function fakeYoutube(available: Record<string, number>): HttpGet & { calls: string[] } {
    const calls: string[] = [];
    const f = ((url: string) => {
      calls.push(url);
      if (url.includes('/oembed')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ title: 'Mon pull de fou', author_name: 'TCG Chaîne' }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      }
      const name = /\/([a-z]+)\.jpg$/.exec(url)?.[1] ?? '';
      const size = available[name];
      return Promise.resolve({
        ok: size !== undefined,
        status: size !== undefined ? 200 : 404,
        json: () => Promise.reject(new Error('binaire')),
        arrayBuffer: () => Promise.resolve(new Uint8Array(size ?? 0).buffer),
      });
    }) as HttpGet & { calls: string[] };
    f.calls = calls;
    return f;
  }

  it('prend maxres en 16:9, la verticale si elle existe, et tient un index', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-inspi-'));
    const f = fakeYoutube({ oardefault: 50_000, maxresdefault: 90_000, hqdefault: 20_000 });
    const entry = await downloadYoutubeThumbnails(
      'https://www.youtube.com/shorts/aBcDeFgHiJk',
      dir,
      f,
    );
    expect(entry.files.map((x) => `${x.format}:${x.variant}`)).toEqual([
      '9x16:oardefault',
      '16x9:maxresdefault',
    ]);
    expect(entry.title).toBe('Mon pull de fou');
    expect(fs.existsSync(path.join(dir, 'tcg-chaine-mon-pull-de-fou-aBcDeFgHiJk-16x9.jpg'))).toBe(
      true,
    );
    expect(f.calls.some((u) => u.includes('hqdefault'))).toBe(false); // 16:9 déjà trouvé
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(1);
  });

  it('se rabat sur sd/hq quand maxres manque, ignore l’image de remplacement', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-inspi-'));
    const f = fakeYoutube({ maxresdefault: 1000, sddefault: 30_000 });
    const entry = await downloadYoutubeThumbnails('https://youtu.be/dQw4w9WgXcQ', dir, f);
    expect(entry.files.map((x) => x.variant)).toEqual(['sddefault']);
  });

  it('échoue proprement sur un lien non YouTube ou sans aucune miniature', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-inspi-'));
    await expect(
      downloadYoutubeThumbnails('https://tiktok.com/x', dir, fakeYoutube({})),
    ).rejects.toThrow(/non reconnu/);
    await expect(downloadYoutubeThumbnails('dQw4w9WgXcQ', dir, fakeYoutube({}))).rejects.toThrow(
      /aucune miniature/,
    );
  });
});
