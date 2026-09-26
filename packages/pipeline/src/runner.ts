import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  contents,
  jobs,
  jobSteps,
  loadAccount,
  type LoadedAccount,
  type PipelineStep,
} from '@outil/core';
import type { PipelineContext } from './context.js';
import { notifyFailed, notifyReady } from './notify.js';
import {
  isStepDone,
  loadState,
  PIPELINE_ORDER,
  saveState,
  statePath,
  type PipelineState,
} from './state.js';
import { captions } from './steps/captions.js';
import { deliver } from './steps/deliver.js';
import { edl } from './steps/edl.js';
import { ingest } from './steps/ingest.js';
import { qc } from './steps/qc.js';
import { render } from './steps/render.js';
import { tag } from './steps/tag.js';
import { thumbnail } from './steps/thumbnail.js';

/** Une étape lit et enrichit l'état ; le runner journalise et persiste autour. */
export type StepFn = (
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
) => Promise<void>;

export const DEFAULT_STEPS: Record<Exclude<PipelineStep, 'ingest'>, StepFn> = {
  tag,
  edl,
  render,
  captions,
  thumbnail,
  qc: (p, state, account) => qc(p, state, account.config.durationRange),
  deliver: (p, state) => {
    deliver(p, state);
    return Promise.resolve();
  },
  notify: (p, state) => notifyReady(p, state),
};

export interface RunOptions {
  /** Étapes de remplacement (tests) */
  steps?: Partial<Record<Exclude<PipelineStep, 'ingest'>, StepFn>>;
  /** Arrêt propre demandé : l'étape en cours se termine, les suivantes attendent la reprise */
  signal?: AbortSignal | undefined;
}

/** Levée quand un arrêt propre interrompt un contenu entre deux étapes (il sera repris). */
export class InterruptedError extends Error {
  constructor(public readonly contentId: string) {
    super(`${contentId} interrompu — repris au prochain lancement`);
    this.name = 'InterruptedError';
  }
}

/**
 * Exécute les étapes restantes d'un contenu, dans l'ordre. Chaque étape : ligne `job_steps`
 * « running » → « done » / « failed », état sauvegardé après succès. Un échec marque le job et le
 * contenu, envoie l'alerte d'échec, puis remonte l'erreur. Les étapes déjà faites sont sautées.
 */
export async function runSteps(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
  jobId: number,
  options: RunOptions = {},
): Promise<PipelineState> {
  const steps = { ...DEFAULT_STEPS, ...options.steps };
  for (const step of PIPELINE_ORDER) {
    if (step === 'ingest' || isStepDone(state, step)) continue;
    if (options.signal?.aborted) {
      const at = new Date().toISOString();
      p.db
        .update(jobs)
        .set({ status: 'interrupted', currentStep: null, finishedAt: at })
        .where(eq(jobs.id, jobId))
        .run();
      p.db
        .update(contents)
        .set({ status: 'interrupted', updatedAt: at })
        .where(eq(contents.id, state.contentId))
        .run();
      p.log(`⏸ ${state.contentId} interrompu avant « ${step} » — repris au prochain lancement`);
      throw new InterruptedError(state.contentId);
    }
    const started = performance.now();
    const row = p.db.insert(jobSteps).values({ jobId, step, status: 'running' }).returning().get();
    p.db.update(jobs).set({ currentStep: step }).where(eq(jobs.id, jobId)).run();
    p.log(`▶ ${step}`);
    try {
      await steps[step](p, state, account);
      state.completedSteps.push(step);
      saveState(state);
      p.db
        .update(jobSteps)
        .set({
          status: 'done',
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
        })
        .where(eq(jobSteps.id, row.id))
        .run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.db
        .update(jobSteps)
        .set({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          error: message,
        })
        .where(eq(jobSteps.id, row.id))
        .run();
      p.db
        .update(jobs)
        .set({ status: 'failed', error: message, finishedAt: new Date().toISOString() })
        .where(eq(jobs.id, jobId))
        .run();
      p.db
        .update(contents)
        .set({ status: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(contents.id, state.contentId))
        .run();
      p.log(`✖ ${step} : ${message}`);
      await notifyFailed(p, {
        event: 'failed',
        contentId: state.contentId,
        account: state.account,
        step,
        error: message,
        workDir: state.workDir,
      });
      throw err;
    }
  }
  p.db
    .update(jobs)
    .set({ status: 'done', currentStep: null, finishedAt: new Date().toISOString() })
    .where(eq(jobs.id, jobId))
    .run();
  p.log(`✔ ${state.contentId} terminé`);
  return state;
}

/** Nouveau contenu : ingestion puis toutes les étapes. */
export async function runContent(
  p: PipelineContext,
  input: { accountSlug: string; inputDir: string },
  options: RunOptions = {},
): Promise<PipelineState> {
  const account = loadAccount(input.accountSlug, p.ctx.accountsDir);
  const { state, jobId } = await ingest(p, { account, inputDir: input.inputDir });
  return runSteps(p, state, account, jobId, options);
}

/** Retrouve l'état d'un contenu : en cours (/processing) ou livré (/ready/<compte>/<id>/work). */
export function locateState(p: PipelineContext, contentId: string): PipelineState {
  const processing = p.ctx.paths.processing(contentId);
  if (fs.existsSync(statePath(processing))) return loadState(processing);
  const row = p.db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (row) {
    const work = path.join(p.ctx.paths.ready(row.account, contentId), 'work');
    if (fs.existsSync(statePath(work))) return loadState(work);
  }
  throw new Error(`contenu ${contentId} introuvable (ni en cours, ni livré)`);
}

/** Reprise d'un contenu interrompu ou en échec : nouveau job, étapes restantes seulement. */
export async function resumeContent(
  p: PipelineContext,
  contentId: string,
  options: RunOptions = {},
): Promise<PipelineState> {
  const state = locateState(p, contentId);
  const account = loadAccount(state.account, p.ctx.accountsDir);
  const previous = p.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.contentId, contentId), eq(jobs.kind, 'pipeline')))
    .orderBy(desc(jobs.id))
    .get();
  const job = p.db
    .insert(jobs)
    .values({
      contentId,
      kind: 'pipeline',
      status: 'running',
      attempt: (previous?.attempt ?? 0) + 1,
      startedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  p.db
    .update(contents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(contents.id, contentId))
    .run();
  p.log(`reprise de ${contentId} (étapes faites : ${state.completedSteps.join(', ')})`);
  return runSteps(p, state, account, job.id, options);
}
