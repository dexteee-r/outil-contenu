import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { EdlFraming } from '../schemas/edl.js';

const execFileAsync = promisify(execFile);

/** Extrait une image PNG du clip à l'instant donné (ffmpeg). */
export async function extractFrame(clipPath: string, atSec: number, out: string): Promise<string> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    clipPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    out,
  ]);
  return out;
}

/**
 * Netteté d'une image : écart-type d'un laplacien sur le gris (plus c'est haut, moins il y a de
 * flou de bougé). Sert à choisir la meilleure image parmi plusieurs instants candidats.
 */
export async function sharpness(image: Buffer | string): Promise<number> {
  const { channels } = await sharp(image)
    .greyscale()
    .resize({ width: 480, withoutEnlargement: true })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  return channels[0]?.stdev ?? 0;
}

export interface KeyFrameCandidate {
  atSec: number;
  path: string;
  sharpness: number;
}

/** Extrait chaque instant candidat et renvoie le plus net (les autres fichiers sont supprimés). */
export async function pickSharpestFrame(
  clipPath: string,
  candidatesSec: number[],
  outDir: string,
): Promise<KeyFrameCandidate> {
  const unique = [...new Set(candidatesSec.map((s) => Math.round(s * 10) / 10))];
  const scored: KeyFrameCandidate[] = [];
  for (const atSec of unique) {
    const file = path.join(outDir, `candidate-${atSec.toFixed(1)}.png`);
    await extractFrame(clipPath, atSec, file);
    scored.push({ atSec, path: file, sharpness: await sharpness(file) });
  }
  scored.sort((a, b) => b.sharpness - a.sharpness);
  const best = scored[0];
  if (!best) throw new Error('aucun instant candidat');
  for (const c of scored.slice(1)) fs.rmSync(c.path, { force: true });
  return best;
}

/** Applique le cadrage d'un segment EDL (zoom autour d'un point) à une image : mêmes règles que le rendu. */
export async function cropByFraming(image: Buffer | string, framing: EdlFraming): Promise<Buffer> {
  const img = sharp(image);
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height || framing.zoom <= 1) return img.png().toBuffer();
  const w = Math.round(width / framing.zoom);
  const h = Math.round(height / framing.zoom);
  const left = Math.min(width - w, Math.max(0, Math.round(framing.focusX * width - w / 2)));
  const top = Math.min(height - h, Math.max(0, Math.round(framing.focusY * height - h / 2)));
  return img.extract({ left, top, width: w, height: h }).png().toBuffer();
}
