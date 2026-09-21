import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeVideo } from './ffprobe.js';
import { makeProxy, proxyArgs, proxyPathFor } from './proxy.js';
import { makeSyntheticClip } from './synthetic.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-proxy-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('proxyArgs / proxyPathFor', () => {
  it('limite hauteur et cadence, encode en H.264/AAC faststart', () => {
    const args = proxyArgs({ input: 'a.mov', output: 'a.proxy.mp4', maxHeight: 540, maxFps: 25 });
    expect(args.join(' ')).toContain("scale=-2:'min(540,ih)',fps=25");
    expect(args).toContain('libx264');
    expect(args).toContain('+faststart');
    expect(args.at(-1)).toBe('a.proxy.mp4');
  });

  it('nomme le proxy d’après le rush', () => {
    expect(proxyPathFor('E:\\contenu\\raw\\tcg\\IMG_0042.MOV', 'C:\\tmp')).toBe(
      path.join('C:\\tmp', 'IMG_0042.proxy.mp4'),
    );
  });
});

describe('makeProxy (ffmpeg réel)', () => {
  it('réduit un clip 1080x1920 en 405x720 et garde l’audio', async () => {
    const src = await makeSyntheticClip({
      out: path.join(dir, 'src.mp4'),
      durationSec: 2,
      width: 1080,
      height: 1920,
      fps: 60,
    });
    const out = await makeProxy({ input: src, output: proxyPathFor(src, dir) });
    const probe = await probeVideo(out);
    expect(probe.height).toBe(720);
    expect(probe.width).toBe(406); // -2 : largeur paire la plus proche de 405
    expect(probe.fps).toBe(30);
    expect(probe.hasAudio).toBe(true);
    expect(probe.codec).toBe('h264');
    expect(fs.statSync(out).size).toBeLessThan(fs.statSync(src).size);
  }, 60_000);
});
