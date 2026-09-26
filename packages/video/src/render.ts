import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { ClipInfo, Edl } from '@outil/core';
import { COMPOSITION_ID } from './Root';
import { startMediaServer } from './serve';
import { buildTimeline, DEFAULT_FPS, type SfxKind, type Timeline } from './timeline';

export { buildTimeline, buildSfxCues, musicVolumeAt } from './timeline';
export type { SfxCue, SfxKind, Timeline } from './timeline';
export { startMediaServer } from './serve';

const ENTRY_POINT = fileURLToPath(new URL('./index.ts', import.meta.url));

/** Télécharge Chrome Headless Shell si besoin (une fois par machine). */
export async function ensureRenderBrowser(onProgress?: (percent: number) => void): Promise<void> {
  await ensureBrowser({
    onBrowserDownload: () => ({
      version: null,
      onProgress: ({ percent }) => onProgress?.(percent),
    }),
  });
}

/** Bundle webpack de la composition ; réutilisable entre plusieurs rendus. */
export async function bundleVideo(outDir?: string): Promise<string> {
  const options: Parameters<typeof bundle>[0] = { entryPoint: ENTRY_POINT };
  if (outDir) options.outDir = outDir;
  return bundle(options);
}

export interface RenderEdlOptions {
  edl: Edl;
  clips: ClipInfo[];
  /** Fichier MP4 de sortie */
  out: string;
  music?: { path: string; volume?: number } | null;
  /** Sons d'habillage (fichiers locaux + durée) : hit, montée de tension, whoosh, pop */
  sfx?: Partial<Record<SfxKind, { path: string; durationSec: number } | null>>;
  fps?: number;
  /** Bundle déjà construit (sinon bundle à la volée) */
  serveUrl?: string;
  onProgress?: (percent: number, stage: 'bundle' | 'render') => void;
}

export interface RenderEdlResult {
  out: string;
  timeline: Timeline;
  bundleMs: number;
  renderMs: number;
}

/** Rend un EDL en MP4 1080x1920 (H.264 + AAC). */
export async function renderEdl(o: RenderEdlOptions): Promise<RenderEdlResult> {
  const t0 = performance.now();
  const serveUrl = o.serveUrl ?? (await bundleVideo());
  const bundleMs = Math.round(performance.now() - t0);

  const media = await startMediaServer();
  try {
    const musicSrc = o.music ? media.mount(o.music.path) : null;
    const timelineOptions: Parameters<typeof buildTimeline>[0] = {
      edl: o.edl,
      clips: o.clips,
      srcFor: (clip) => media.mount(clip.path),
      fps: o.fps ?? DEFAULT_FPS,
      music: musicSrc
        ? { src: musicSrc, ...(o.music?.volume !== undefined ? { volume: o.music.volume } : {}) }
        : null,
      sfx: Object.fromEntries(
        Object.entries(o.sfx ?? {}).map(([kind, s]) => [
          kind,
          s ? { src: media.mount(s.path), durationSec: s.durationSec } : null,
        ]),
      ),
    };
    const timeline = buildTimeline(timelineOptions);
    const inputProps = { timeline };

    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
    fs.mkdirSync(path.dirname(o.out), { recursive: true });

    const t1 = performance.now();
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: o.out,
      inputProps,
      onProgress: ({ progress }) => o.onProgress?.(Math.round(progress * 100), 'render'),
    });
    return { out: o.out, timeline, bundleMs, renderMs: Math.round(performance.now() - t1) };
  } finally {
    await media.close();
  }
}
