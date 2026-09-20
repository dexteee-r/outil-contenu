import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ICO_SIZES, pngsToIco, readIcoDirectory, svgToIco } from './ico.js';
import { buildTrayIcons, TRAY_COLORS, TRAY_STATES, trayIconSvg } from './tray-icon.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('pngsToIco', () => {
  it('écrit un en-tête ICO valide et des offsets contigus', () => {
    const a = Buffer.from('AAAA');
    const b = Buffer.from('BBBBBBBB');
    const ico = pngsToIco([
      { size: 16, png: a },
      { size: 256, png: b },
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
    expect(() => pngsToIco([])).toThrow(/au moins une image/);
    expect(() => pngsToIco([{ size: 512, png: Buffer.alloc(1) }])).toThrow(/taille invalide/);
  });
});

describe('svgToIco', () => {
  it('rend chaque taille en PNG décodable aux bonnes dimensions', async () => {
    const ico = await svgToIco((s) => trayIconSvg('running', s));
    const dir = readIcoDirectory(ico);
    expect(dir.map((d) => d.size)).toEqual([...ICO_SIZES]);
    for (const entry of dir) {
      const png = ico.subarray(entry.offset, entry.offset + entry.bytes);
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([entry.size, entry.size]);
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

  it('écrit un .ico par état', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-icons-'));
    const files = await buildTrayIcons(dir);
    expect(Object.keys(files).sort()).toEqual([...TRAY_STATES].sort());
    for (const file of Object.values(files)) {
      expect(readIcoDirectory(fs.readFileSync(file))).toHaveLength(ICO_SIZES.length);
    }
  });
});
