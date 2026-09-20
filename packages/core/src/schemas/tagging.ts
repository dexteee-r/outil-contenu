import { z } from 'zod';

/**
 * Contrat de tagging vidéo (étape `tag`, produit par Gemini).
 *
 * Deux niveaux :
 * - `taggingOutputSchema` : ce que le modèle doit renvoyer — tous les champs requis,
 *   pas de valeurs par défaut, pour rester compatible avec les sorties structurées.
 * - `taggingResultSchema` : l'objet enrichi conservé par le pipeline (infos ffprobe
 *   des clips + sortie du modèle + provenance).
 */

export const HIGHLIGHT_KINDS = ['hook', 'climax', 'reaction', 'b-roll'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

/** Ce que l'étape `ingest` sait d'un rush (ffprobe). */
export const clipInfoSchema = z
  .object({
    id: z.string().min(1), // ex. "rush-01"
    path: z.string().min(1),
    durationSec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive().optional(),
    hasAudio: z.boolean(),
  })
  .strict();
export type ClipInfo = z.infer<typeof clipInfoSchema>;

const seconds = z.number().nonnegative();

export const sceneSchema = z
  .object({
    start: seconds,
    end: seconds,
    description: z.string().min(1),
    tags: z.array(z.string()),
    audioEvents: z.array(z.string()), // ex. "déchirure du booster", "exclamation"
  })
  .strict();
export type Scene = z.infer<typeof sceneSchema>;

export const transcriptSegmentSchema = z
  .object({ start: seconds, end: seconds, text: z.string().min(1) })
  .strict();
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/** Moment fort candidat pour le montage ; le climax TCG (carte qui sort, réaction) en fait partie. */
export const highlightSchema = z
  .object({
    clipId: z.string().min(1),
    start: seconds,
    end: seconds,
    score: z.number().min(0).max(1),
    kind: z.enum(HIGHLIGHT_KINDS),
    reason: z.string().min(1),
  })
  .strict();
export type Highlight = z.infer<typeof highlightSchema>;

export const clipTaggingSchema = z
  .object({
    clipId: z.string().min(1),
    summary: z.string().min(1),
    scenes: z.array(sceneSchema).min(1),
    transcript: z.array(transcriptSegmentSchema),
  })
  .strict();
export type ClipTagging = z.infer<typeof clipTaggingSchema>;

/** Sortie attendue du modèle de tagging. */
export const taggingOutputSchema = z
  .object({
    clips: z.array(clipTaggingSchema).min(1),
    highlights: z.array(highlightSchema),
    summary: z.string().min(1),
  })
  .strict();
export type TaggingOutput = z.infer<typeof taggingOutputSchema>;

/** Objet conservé par le pipeline : infos clip + tagging + provenance. */
export const taggingResultSchema = z
  .object({
    clips: z.array(clipInfoSchema.extend(clipTaggingSchema.omit({ clipId: true }).shape)).min(1),
    highlights: z.array(highlightSchema),
    summary: z.string().min(1),
    model: z.string().min(1),
    taggedAt: z.iso.datetime(),
  })
  .strict();
export type TaggingResult = z.infer<typeof taggingResultSchema>;

export interface TaggingIssue {
  path: string;
  message: string;
}

/**
 * Cohérence de la sortie du modèle avec les clips réels : ids connus, chaque clip couvert,
 * bornes dans la durée du clip. Un problème ici se renvoie au modèle ou se corrige.
 */
export function validateTaggingOutput(
  output: TaggingOutput,
  clips: ClipInfo[],
  toleranceSec = 0.05,
): TaggingIssue[] {
  const issues: TaggingIssue[] = [];
  const byId = new Map(clips.map((c) => [c.id, c]));

  const checkRange = (path: string, clipId: string, start: number, end: number) => {
    const clip = byId.get(clipId);
    if (!clip) {
      issues.push({
        path,
        message: `clipId "${clipId}" inconnu (clips : ${[...byId.keys()].join(', ')})`,
      });
      return;
    }
    if (start >= end) issues.push({ path, message: `start (${start}) doit être < end (${end})` });
    if (end > clip.durationSec + toleranceSec) {
      issues.push({
        path,
        message: `end (${end}) dépasse la durée du clip "${clipId}" (${clip.durationSec} s)`,
      });
    }
  };

  const seen = new Set<string>();
  output.clips.forEach((clip, i) => {
    if (seen.has(clip.clipId))
      issues.push({ path: `clips[${i}]`, message: `clipId "${clip.clipId}" en double` });
    seen.add(clip.clipId);
    clip.scenes.forEach((s, j) =>
      checkRange(`clips[${i}].scenes[${j}]`, clip.clipId, s.start, s.end),
    );
    clip.transcript.forEach((t, j) =>
      checkRange(`clips[${i}].transcript[${j}]`, clip.clipId, t.start, t.end),
    );
  });
  for (const clip of clips) {
    if (!seen.has(clip.id))
      issues.push({ path: 'clips', message: `clip "${clip.id}" absent de la sortie` });
  }
  output.highlights.forEach((h, i) => checkRange(`highlights[${i}]`, h.clipId, h.start, h.end));

  return issues;
}

/** Fusionne infos ffprobe et sortie du modèle en `TaggingResult`. Suppose `validateTaggingOutput` sans erreur. */
export function mergeTagging(
  clips: ClipInfo[],
  output: TaggingOutput,
  provenance: { model: string; taggedAt?: string },
): TaggingResult {
  const byId = new Map(output.clips.map((c) => [c.clipId, c]));
  return taggingResultSchema.parse({
    clips: clips.map((clip) => {
      const tagged = byId.get(clip.id);
      if (!tagged) throw new Error(`clip "${clip.id}" absent de la sortie de tagging`);
      const { clipId: _clipId, ...rest } = tagged;
      return { ...clip, ...rest };
    }),
    highlights: output.highlights,
    summary: output.summary,
    model: provenance.model,
    taggedAt: provenance.taggedAt ?? new Date().toISOString(),
  });
}
