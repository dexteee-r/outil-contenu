import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ICO_SIZES, packIco, readIcoDirectory, rgbaToDib, svgToIco } from './ico.js';
import {
  APP_ICON_FILE,
  buildAppIcon,
  buildTrayIcons,
  TRAY_COLORS,
  TRAY_STATES,
  trayIconSvg,
} from './tray-icon.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('packIco', () => {
  it('écrit un en-tête ICO valide et des offsets contigus', () => {
    const a = Buffer.from('AAAA');
    const b = Buffer.from('BBBBBBBB');
    const ico = packIco([
      { size: 16, data: a },
      { size: 256, data: b },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    const dir = readIcoDirectory(ico);
    expect(dir).toEqual([
      { size: 16, bytes: 4, offset: 6 + 32 },
      { size: 256, bytes: 8, offset: 6 + 32 + 4 },
    ]);
    expect(ico.subarray(dir[0]!.offset, dir[0]!.offset + 4).toString()).toBe('AAAA');
    expect(ico.subarray(dir[1]!.offset, dir[1]!.offset + 8).toString()).toBe('BBBBBBBB');
    expect(ico.length).toBe(6 + 32 + 12);
  });

  it('refuse une liste vide et une taille hors bornes', () => {
    expect(() => packIco([])).toThrow(/au moins une image/);
    expect(() => packIco([{ size: 512, data: Buffer.alloc(1) }])).toThrow(/taille invalide/);
  });
});

describe('rgbaToDib', () => {
  it('BGRA de bas en haut, hauteur doublée, masque à zéro', () => {
    // 2x2 : haut = rouge, vert ; bas = bleu, blanc semi-transparent
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
    const dib = rgbaToDib(2, rgba);
    expect(dib.readUInt32LE(0)).toBe(40);
    expect(dib.readInt32LE(4)).toBe(2);
    expect(dib.readInt32LE(8)).toBe(4);
    expect(dib.readUInt16LE(14)).toBe(32);
    const px = (i: number) => [...dib.subarray(40 + i * 4, 44 + i * 4)];
    expect(px(0)).toEqual([255, 0, 0, 255]); // bleu (ligne du bas en premier)
    expect(px(1)).toEqual([255, 255, 255, 128]);
    expect(px(2)).toEqual([0, 0, 255, 255]); // rouge
    expect(px(3)).toEqual([0, 255, 0, 255]);
    expect(dib.length).toBe(40 + 16 + 4 * 2); // masque : une ligne de 4 octets par rangée
    expect(dib.subarray(56).every((b) => b === 0)).toBe(true);
    expect(() => rgbaToDib(3, rgba)).toThrow(/incomplets/);
  });
});

describe('svgToIco', () => {
  it('BMP aux petites tailles, PNG à 256 px', async () => {
    const ico = await svgToIco((s) => trayIconSvg('running', s));
    const dir = readIcoDirectory(ico);
    expect(dir.map((d) => d.size)).toEqual([...ICO_SIZES]);
    for (const entry of dir) {
      const data = ico.subarray(entry.offset, entry.offset + entry.bytes);
      if (entry.size === 256) {
        expect(data.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
        const meta = await sharp(data).metadata();
        expect([meta.width, meta.height]).toEqual([256, 256]);
      } else {
        expect(data.readUInt32LE(0)).toBe(40);
        expect(data.readInt32LE(4)).toBe(entry.size);
        // Pixel du bord gauche, à mi-hauteur : la couleur de l'état, opaque
        const row = Math.floor(entry.size / 2);
        const at = 40 + (row * entry.size + 1) * 4;
        expect([...data.subarray(at, at + 4)]).toEqual([0x71, 0xbf, 0x2f, 255]); // #2FBF71 en BGRA
      }
    }
  });
});

describe('trayIconSvg / buildTrayIcons', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('utilise la couleur de l’état', () => {
    for (const state of TRAY_STATES) {
      expect(trayIconSvg(state, 32)).toContain(TRAY_COLORS[state]);
    }
  });

  it('écrit un .ico par état, et celui du raccourci', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-icons-'));
    const files = await buildTrayIcons(dir);
    expect(Object.keys(files).sort()).toEqual([...TRAY_STATES].sort());
    for (const file of Object.values(files)) {
      expect(readIcoDirectory(fs.readFileSync(file))).toHaveLength(ICO_SIZES.length);
    }
    expect(path.basename(await buildAppIcon(dir))).toBe(APP_ICON_FILE);
  });
});
