import fs from 'node:fs';
import sharp from 'sharp';
import {
  edlDurationSec,
  probeVideo,
  THUMBNAIL_SIZES,
  type ProbeResult,
  type ThumbnailFormat,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

/**
 * Contrôle automatique basique du cahier, avant l'alerte « contenu prêt » : durée dans la plage
 * attendue, piste audio présente, fichier lisible, miniatures aux bonnes dimensions.
 */
export interface QcInput {
  video: ProbeResult;
  expectedDurationSec: number;
  durationRange: { min: number; max: number };
  thumbnails: { format: ThumbnailFormat; width: number; height: number }[];
}

/** Vérifications pures (testables sans fichiers). */
export function checkOutputs(input: QcInput): string[] {
  const issues: string[] = [];
  const v = input.video;
  if (v.width !== 1080 || v.height !== 1920)
    issues.push(`vidéo ${v.width}x${v.height}, attendu 1080x1920`);
  if (!v.hasAudio) issues.push('vidéo sans piste audio');
  if (Math.abs(v.durationSec - input.expectedDurationSec) > 0.5) {
    issues.push(
      `durée ${v.durationSec.toFixed(2)} s, EDL ${input.expectedDurationSec.toFixed(2)} s`,
    );
  }
  if (
    v.durationSec < input.durationRange.min - 0.5 ||
    v.durationSec > input.durationRange.max + 0.5
  ) {
    issues.push(
      `durée ${v.durationSec.toFixed(1)} s hors plage [${input.durationRange.min}, ${input.durationRange.max}]`,
    );
  }
  for (const t of input.thumbnails) {
    const expected = THUMBNAIL_SIZES[t.format];
    if (t.width !== expected.width || t.height !== expected.height) {
      issues.push(
        `miniature ${t.format} ${t.width}x${t.height}, attendu ${expected.width}x${expected.height}`,
      );
    }
  }
  if (input.thumbnails.length === 0) issues.push('aucune miniature');
  return issues;
}

export async function qc(
  p: PipelineContext,
  state: PipelineState,
  durationRange: { min: number; max: number },
): Promise<void> {
  if (!state.render || !state.edl) throw new Error('qc : rendu manquant');
  if (!fs.existsSync(state.render.path))
    throw new Error(`qc : vidéo introuvable ${state.render.path}`);
  const video = await probeVideo(state.render.path);
  const thumbnails = await Promise.all(
    (state.thumbnails ?? []).map(async (t) => {
      const meta = await sharp(t.path).metadata();
      return { format: t.format, width: meta.width ?? 0, height: meta.height ?? 0 };
    }),
  );
  const issues = checkOutputs({
    video,
    expectedDurationSec: edlDurationSec(state.edl),
    durationRange,
    thumbnails,
  });
  if (issues.length) throw new Error(`qc : ${issues.join(' ; ')}`);
  p.log(`qc : OK (${video.durationSec.toFixed(2)} s, audio, ${thumbnails.length} miniatures)`);
}
