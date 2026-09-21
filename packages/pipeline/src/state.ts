import fs from 'node:fs';
import path from 'node:path';
import {
  captionsSchema,
  clipInfoSchema,
  edlSchema,
  PIPELINE_STEPS,
  taggingResultSchema,
  THUMBNAIL_FORMATS,
  type PipelineStep,
} from '@outil/core';
import { z } from 'zod';

/**
 * État d'un contenu en cours de traitement : `<processing>/<content-id>/state.json`.
 * Chaque étape y écrit son résultat ; c'est ce qui rend le pipeline idempotent et reprenable.
 */

export const STATE_FILE = 'state.json';

/** Étapes exécutées par le runner, dans l'ordre (l'ingestion crée l'état, les autres l'enrichissent). */
export const PIPELINE_ORDER: readonly PipelineStep[] = PIPELINE_STEPS;

export const pipelineStateSchema = z
  .object({
    version: z.literal(1),
    contentId: z.string().min(1),
    account: z.string().min(1),
    /** Dossier /raw d'origine */
    sourceDir: z.string().min(1),
    /** Dossier /processing/<content-id> */
    workDir: z.string().min(1),
    createdAt: z.iso.datetime(),
    completedSteps: z.array(z.enum(PIPELINE_STEPS)),
    /** Noms des rushs d'origine */
    sourceFiles: z.array(z.string().min(1)),
    clips: z.array(clipInfoSchema).optional(),
    tagging: taggingResultSchema.optional(),
    edl: edlSchema.optional(),
    edlAttempts: z.number().int().optional(),
    music: z
      .object({ file: z.string(), title: z.string(), license: z.string() })
      .strict()
      .nullable()
      .optional(),
    render: z
      .object({
        path: z.string(),
        durationSec: z.number(),
        width: z.number().int(),
        height: z.number().int(),
        renderMs: z.number().int(),
      })
      .strict()
      .optional(),
    captions: captionsSchema.optional(),
    thumbnailTitle: z.string().optional(),
    thumbnails: z
      .array(
        z
          .object({
            path: z.string(),
            format: z.enum(THUMBNAIL_FORMATS),
            variant: z.number().int().positive(),
            selected: z.boolean(),
            /** D'où vient le visuel : généré par IA ou image réelle du climax */
            background: z.enum(['ai', 'frame']),
          })
          .strict(),
      )
      .optional(),
    models: z
      .object({
        tagging: z.string().optional(),
        edl: z.string().optional(),
        captions: z.string().optional(),
        image: z.string().optional(),
      })
      .strict()
      .optional(),
    deliveredDir: z.string().optional(),
  })
  .strict();
export type PipelineState = z.infer<typeof pipelineStateSchema>;

export function statePath(workDir: string): string {
  return path.join(workDir, STATE_FILE);
}

export function saveState(state: PipelineState): void {
  fs.mkdirSync(state.workDir, { recursive: true });
  const tmp = `${statePath(state.workDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pipelineStateSchema.parse(state), null, 2));
  fs.renameSync(tmp, statePath(state.workDir)); // écriture atomique : jamais d'état à moitié écrit
}

export function loadState(workDir: string): PipelineState {
  const file = statePath(workDir);
  if (!fs.existsSync(file)) throw new Error(`état introuvable : ${file}`);
  return pipelineStateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function isStepDone(state: PipelineState, step: PipelineStep): boolean {
  return state.completedSteps.includes(step);
}
