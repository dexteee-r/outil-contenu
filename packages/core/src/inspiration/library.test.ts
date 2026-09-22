import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectImageType,
  listInspiration,
  removeInspiration,
  safeImageName,
  saveUploadedImage,
} from './library.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-lib-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();

describe('safeImageName', () => {
  it('accepte un nom d’image simple, refuse chemins et extensions non image', () => {
    expect(safeImageName('abc-16x9.jpg')).toBe('abc-16x9.jpg');
    expect(safeImageName('../account.yaml')).toBeNull();
    expect(safeImageName('..\\..\\x.png')).toBeNull();
    expect(safeImageName('sub/x.png')).toBeNull();
    expect(safeImageName('index.json')).toBeNull();
    expect(safeImageName('.hidden.png')).toBeNull();
    expect(safeImageName('a:b.png')).toBeNull();
  });
});

describe('detectImageType', () => {
  it('reconnaît PNG, JPEG, WebP par leurs octets', async () => {
    expect(detectImageType(await png())).toBe('png');
    expect(
      detectImageType(
        await sharp(await png())
          .jpeg()
          .toBuffer(),
      ),
    ).toBe('jpg');
    expect(
      detectImageType(
        await sharp(await png())
          .webp()
          .toBuffer(),
      ),
    ).toBe('webp');
    expect(detectImageType(Buffer.from('<html>'))).toBeNull();
  });
});

describe('saveUploadedImage / listInspiration / removeInspiration', () => {
  it('enregistre avec l’extension réelle, dédoublonne, liste et supprime', async () => {
    const data = await png();
    expect(saveUploadedImage(dir, 'Capture TikTok é!.jpg', data)).toBe('Capture-TikTok-e.png');
    expect(saveUploadedImage(dir, 'Capture TikTok é!.jpg', data)).toBe('Capture-TikTok-e-2.png');
    expect(() => saveUploadedImage(dir, 'x.png', Buffer.from('pas une image'))).toThrow(
      /non reconnu/,
    );

    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify([
        {
          id: 'abc',
          url: 'https://www.youtube.com/watch?v=abc',
          title: 'Titre',
          channel: 'Chaîne',
          addedAt: '2026-09-22T00:00:00.000Z',
          files: [
            {
              format: '16x9',
              variant: 'maxresdefault',
              file: path.join(dir, 'yt-16x9.jpg'),
              bytes: 1,
            },
          ],
        },
      ]),
    );
    fs.writeFileSync(path.join(dir, 'yt-16x9.jpg'), await sharp(data).jpeg().toBuffer());

    const images = listInspiration(dir);
    expect(images.map((i) => i.name).sort()).toEqual([
      'Capture-TikTok-e-2.png',
      'Capture-TikTok-e.png',
      'yt-16x9.jpg',
    ]);
    expect(images.find((i) => i.name === 'yt-16x9.jpg')?.source?.channel).toBe('Chaîne');

    removeInspiration(dir, 'yt-16x9.jpg');
    expect(fs.existsSync(path.join(dir, 'yt-16x9.jpg'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual([]);
    expect(() => removeInspiration(dir, '../index.json')).toThrow(/refusé/);
    expect(() => removeInspiration(dir, 'absent.png')).toThrow(/introuvable/);
  });

  it('liste vide si le dossier n’existe pas', () => {
    expect(listInspiration(path.join(dir, 'nope'))).toEqual([]);
  });
});
