import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Médias synthétiques générés par ffmpeg : mire + timecode incrusté + son.
 * Servent aux spikes et aux tests de rendu sans attendre de vrais rushs.
 */

export interface SyntheticClipOptions {
  out: string;
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Texte incrusté en plus du timecode (ex. l'id du clip) */
  label?: string;
  /** Fréquence du bip (Hz) ; permet de distinguer les clips à l'oreille */
  toneHz?: number;
}

/** Arguments ffmpeg (purs, testables) pour un clip mire + timecode + sinusoïde. */
export function syntheticClipArgs(o: SyntheticClipOptions): string[] {
  const width = o.width ?? 1080;
  const height = o.height ?? 1920;
  const fps = o.fps ?? 30;
  const label = (o.label ?? path.basename(o.out)).replace(/[\\:']/g, ' ');
  const fontSize = Math.round(height / 18);
  const drawtext = [
    `drawtext=text='${label}':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-text_w)/2:y=h*0.25`,
    `drawtext=text='%{pts\\:hms}':fontsize=${fontSize}:fontcolor=yellow:box=1:boxcolor=black@0.6:x=(w-text_w)/2:y=h*0.5`,
  ].join(',');
  return [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${o.durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${o.toneHz ?? 440}:duration=${o.durationSec}`,
    '-vf',
    drawtext,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    o.out,
  ];
}

export async function makeSyntheticClip(o: SyntheticClipOptions): Promise<string> {
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  await execFileAsync('ffmpeg', syntheticClipArgs(o), { maxBuffer: 16 * 1024 * 1024 });
  return o.out;
}

/** Piste « musique » synthétique : deux notes qui alternent sur un tempo donné. */
export function syntheticMusicArgs(o: {
  out: string;
  durationSec: number;
  bpm?: number;
}): string[] {
  const bpm = o.bpm ?? 120;
  const beat = 60 / bpm;
  // Alternance de deux fréquences à chaque temps, avec une enveloppe pour marquer le rythme.
  // L'expression contient des virgules : elle doit être entre quotes pour le parseur de filtres.
  const expr = `0.3*sin(2*PI*(220+110*floor(mod(t/${beat},2)))*t)*abs(sin(PI*t/${beat}))`;
  return [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs='${expr}':s=44100:d=${o.durationSec}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    o.out,
  ];
}

export async function makeSyntheticMusic(o: {
  out: string;
  durationSec: number;
  bpm?: number;
}): Promise<string> {
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  await execFileAsync('ffmpeg', syntheticMusicArgs(o), { maxBuffer: 16 * 1024 * 1024 });
  return o.out;
}

/** Son « hit » de substitution : deux notes montantes (0,5 s) avec enveloppe, en attendant un vrai SFX. */
export function syntheticHitSfxArgs(out: string): string[] {
  const expr = '0.6*(sin(2*PI*880*t)+0.5*sin(2*PI*1320*t))*exp(-6*t)*(1-exp(-200*t))';
  return [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs='${expr}':s=44100:d=0.5`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    out,
  ];
}

export async function makeSyntheticHitSfx(out: string): Promise<string> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await execFileAsync('ffmpeg', syntheticHitSfxArgs(out), { maxBuffer: 16 * 1024 * 1024 });
  return out;
}
