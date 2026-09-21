import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Proxy léger d'un rush : H.264 + AAC en MP4, hauteur limitée, rotation appliquée.
 * Sert au tagging (Gemini échantillonne la vidéo à basse résolution : inutile d'envoyer du 4K HEVC)
 * et, plus tard, à la prévisualisation. Le rendu final lit toujours le rush d'origine.
 */
export interface ProxyOptions {
  input: string;
  output: string;
  /** Hauteur max en pixels (défaut 720) ; la largeur suit le ratio */
  maxHeight?: number;
  /** Cadence max (défaut 30) */
  maxFps?: number;
  /** Qualité x264 (défaut 26 ; plus petit = meilleur) */
  crf?: number;
}

/** Arguments ffmpeg du proxy (purs, testables). */
export function proxyArgs(o: ProxyOptions): string[] {
  const maxHeight = o.maxHeight ?? 720;
  const maxFps = o.maxFps ?? 30;
  return [
    '-y',
    '-i',
    o.input,
    // scale : ne dépasse pas maxHeight, garde le ratio, dimensions paires ; fps plafonné
    '-vf',
    `scale=-2:'min(${maxHeight},ih)',fps=${maxFps}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(o.crf ?? 26),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    o.output,
  ];
}

export async function makeProxy(o: ProxyOptions): Promise<string> {
  fs.mkdirSync(path.dirname(o.output), { recursive: true });
  await execFileAsync('ffmpeg', proxyArgs(o), { maxBuffer: 16 * 1024 * 1024 });
  return o.output;
}

/** Nom du proxy à côté d'un dossier de travail : "IMG_0042.MOV" → "IMG_0042.proxy.mp4". */
export function proxyPathFor(input: string, dir: string): string {
  return path.join(dir, `${path.basename(input, path.extname(input))}.proxy.mp4`);
}
