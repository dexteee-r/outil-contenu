import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ClipInfo } from '../schemas/tagging.js';

const execFileAsync = promisify(execFile);

/** Sous-ensemble de la sortie `ffprobe -print_format json` qui nous intéresse. */
const ffprobeOutputSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      r_frame_rate: z.string().optional(),
      duration: z.string().optional(),
      // Rotation des vidéos de téléphone (.mov iPhone) : ffprobe récent → side_data_list, ancien → tags.rotate
      side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }),
});

export interface ProbeResult {
  durationSec: number;
  /** Dimensions telles qu'affichées (rotation appliquée) */
  width: number;
  height: number;
  fps: number | undefined;
  hasAudio: boolean;
  codec: string | undefined;
  /** Rotation déclarée dans les métadonnées, en degrés (0, 90, -90, 180) */
  rotation: number;
}

function parseFps(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 1000) / 1000;
}

function parseRotation(stream: {
  side_data_list?: { rotation?: number | undefined }[] | undefined;
  tags?: Record<string, string> | undefined;
}): number {
  const fromSideData = stream.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation;
  const raw = fromSideData ?? Number(stream.tags?.rotate ?? 0);
  const r = ((Math.round(raw) % 360) + 360) % 360;
  return r === 270 ? -90 : r;
}

/** Interprète le JSON de ffprobe (pur, testable sans ffmpeg). */
export function parseProbe(json: unknown): ProbeResult {
  const out = ffprobeOutputSchema.parse(json);
  const video = out.streams.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('aucune piste vidéo');
  const durationSec = Number(out.format.duration ?? video.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('durée illisible');
  const rotation = parseRotation(video);
  const sideways = Math.abs(rotation) === 90;
  return {
    durationSec,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps: parseFps(video.r_frame_rate),
    hasAudio: out.streams.some((s) => s.codec_type === 'audio'),
    codec: video.codec_name,
    rotation,
  };
}

export async function probeVideo(file: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  return parseProbe(JSON.parse(stdout));
}

/** Durée en secondes d'un fichier audio ou vidéo. */
export async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`durée illisible : ${file}`);
  return duration;
}

/** Identifiant de clip stable à partir du nom de fichier : "IMG_0042.MOV" → "img-0042". */
export function clipIdFromFile(file: string, index: number): string {
  const base = path
    .basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `clip-${index + 1}`;
}

/** Sonde une liste de rushs et produit les `ClipInfo` du contrat de tagging. */
export async function probeClips(files: string[]): Promise<ClipInfo[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    files.map(async (file, i) => {
      let id = clipIdFromFile(file, i);
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      const probe = await probeVideo(file);
      const clip: ClipInfo = {
        id,
        path: file,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        hasAudio: probe.hasAudio,
      };
      if (probe.fps !== undefined) clip.fps = probe.fps;
      return clip;
    }),
  );
}
