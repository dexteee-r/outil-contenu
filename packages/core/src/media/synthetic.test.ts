import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeVideo } from './ffprobe.js';
import {
  makeSyntheticClip,
  makeSyntheticHitSfx,
  makeSyntheticMusic,
  syntheticClipArgs,
  syntheticMusicArgs,
} from './synthetic.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-synth-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('syntheticClipArgs', () => {
  it('construit une commande ffmpeg avec mire, timecode et son', () => {
    const args = syntheticClipArgs({
      out: 'x.mp4',
      durationSec: 5,
      width: 720,
      height: 1280,
      fps: 25,
      label: "rush:01'",
    });
    expect(args.join(' ')).toContain('testsrc2=size=720x1280:rate=25:duration=5');
    expect(args.join(' ')).toContain('sine=frequency=440:duration=5');
    expect(args.join(' ')).toContain("text='rush 01 '"); // caractères réservés remplacés
    expect(args.at(-1)).toBe('x.mp4');
  });

  it('la musique synthétique suit le tempo demandé', () => {
    expect(syntheticMusicArgs({ out: 'm.mp3', durationSec: 10, bpm: 120 }).join(' ')).toContain(
      't/0.5',
    );
  });
});

describe('makeSyntheticClip / makeSyntheticMusic (ffmpeg réel)', () => {
  it('produit un clip lisible aux bonnes dimensions avec une piste audio', async () => {
    const out = await makeSyntheticClip({
      out: path.join(dir, 'clip.mp4'),
      durationSec: 2,
      width: 360,
      height: 640,
      fps: 24,
    });
    const probe = await probeVideo(out);
    expect(probe.width).toBe(360);
    expect(probe.height).toBe(640);
    expect(probe.fps).toBe(24);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSec).toBeGreaterThan(1.9);
    expect(probe.durationSec).toBeLessThan(2.3);
  }, 30_000);

  it('produit un son « hit » court', async () => {
    const out = await makeSyntheticHitSfx(path.join(dir, 'hit.mp3'));
    expect(fs.statSync(out).size).toBeGreaterThan(500);
  }, 30_000);

  it('produit une piste audio mp3', async () => {
    const out = await makeSyntheticMusic({ out: path.join(dir, 'music.mp3'), durationSec: 2 });
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  }, 30_000);
});
