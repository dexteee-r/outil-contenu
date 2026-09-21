import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSyntheticClip } from '../media/synthetic.js';
import { cropByFraming, pickSharpestFrame, sharpness } from './frames.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-frames-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sharpness', () => {
  it('note une image nette plus haut qu’une image floue', async () => {
    const pattern = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#000' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="200" height="200"><rect x="40" y="40" width="120" height="120" fill="#fff"/><circle cx="100" cy="100" r="30" fill="#000"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    const blurred = await sharp(pattern).blur(8).png().toBuffer();
    expect(await sharpness(pattern)).toBeGreaterThan(await sharpness(blurred));
  });
});

describe('cropByFraming', () => {
  it('recadre autour du point de focus avec le zoom demandé, et borne aux bords', async () => {
    const img = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const half = await sharp(
      await cropByFraming(img, { zoom: 2, focusX: 0.5, focusY: 0.5 }),
    ).metadata();
    expect([half.width, half.height]).toEqual([500, 250]);
    const corner = await sharp(
      await cropByFraming(img, { zoom: 2, focusX: 1, focusY: 1 }),
    ).metadata();
    expect([corner.width, corner.height]).toEqual([500, 250]);
    const none = await sharp(
      await cropByFraming(img, { zoom: 1, focusX: 0.5, focusY: 0.5 }),
    ).metadata();
    expect([none.width, none.height]).toEqual([1000, 500]);
  });
});

describe('pickSharpestFrame (ffmpeg réel)', () => {
  it('extrait les candidats, garde le plus net, supprime les autres', async () => {
    const clip = await makeSyntheticClip({
      out: path.join(dir, 'clip.mp4'),
      durationSec: 3,
      width: 320,
      height: 560,
      fps: 24,
    });
    const best = await pickSharpestFrame(clip, [0.5, 1.5, 2.5, 2.5], path.join(dir, 'frames'));
    expect(fs.existsSync(best.path)).toBe(true);
    expect(best.sharpness).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(dir, 'frames'))).toEqual([path.basename(best.path)]);
  }, 60_000);
});
