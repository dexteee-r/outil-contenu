import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  contents,
  feedback,
  jobs,
  loadAccount,
  type FeedbackTarget,
  type PipelineStep,
} from '@outil/core';
import type { PipelineContext } from './context.js';
import { clipsFromRaw } from './rethumb.js';
import { locateState, runSteps, type RunOptions } from './runner.js';
import { saveState, type PipelineState } from './state.js';

/** Étapes refaites selon la cible du retour ; les autres résultats sont repris tels quels. */
export const FEEDBACK_REDO: Record<FeedbackTarget, readonly PipelineStep[]> = {
  // Nouveau montage : EDL (avec l'ancien et le retour en contexte) puis rendu
  video: ['edl', 'render', 'qc', 'deliver', 'notify'],
  // Nouvelle miniature : Claude revoit titre, produit et carte (étape des légendes), puis composition
  thumbnail: ['captions', 'thumbnail', 'qc', 'deliver', 'notify'],
};

/**
 * Relance d'un contenu livré avec un retour de Markus (« coupe plus tôt, garde la réaction »).
 * Produit la version n+1 : seules les étapes concernées sont refaites, le reste est repris ; la
 * livraison range la version précédente dans `v<n>/` et une nouvelle notification part.
 */
export async function startFeedback(
  p: PipelineContext,
  contentId: string,
  input: { target: FeedbackTarget; text: string },
  options: RunOptions = {},
): Promise<PipelineState> {
  const text = input.text.trim();
  if (!text) throw new Error('retour vide');
  const row = p.db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!row) throw new Error(`contenu inconnu : ${contentId}`);
  if (row.status !== 'ready') {
    throw new Error(
      `${contentId} n'est pas livré (statut ${row.status}) — termine-le d'abord : pnpm content resume ${contentId}`,
    );
  }
  const delivered = locateState(p, contentId);
  const account = loadAccount(delivered.account, p.ctx.accountsDir);
  const revision = row.version + 1;
  const workDir = p.ctx.paths.processing(contentId);
  fs.mkdirSync(workDir, { recursive: true });

  // Livrables repris copiés dans le dossier de travail : la livraison rangera les originaux dans v<n>/
  const copy = (file: string) => {
    const dest = path.join(workDir, path.basename(file));
    fs.copyFileSync(file, dest);
    return dest;
  };
  const { deliveredDir: _delivered, ...rest } = delivered;
  const redo = FEEDBACK_REDO[input.target];
  const state: PipelineState = {
    ...rest,
    workDir,
    clips: clipsFromRaw(delivered),
    completedSteps: delivered.completedSteps.filter((s) => !redo.includes(s)),
    revision,
    feedback: [
      ...(delivered.feedback ?? []),
      { target: input.target, text, at: new Date().toISOString(), revision },
    ],
    ...(delivered.render
      ? { render: { ...delivered.render, path: copy(delivered.render.path) } }
      : {}),
    ...(delivered.thumbnails
      ? { thumbnails: delivered.thumbnails.map((t) => ({ ...t, path: copy(t.path) })) }
      : {}),
  };
  saveState(state);

  const job = p.db
    .insert(jobs)
    .values({ contentId, kind: 'feedback', status: 'running', startedAt: new Date().toISOString() })
    .returning()
    .get();
  p.db
    .insert(feedback)
    .values({ contentId, target: input.target, text, resultingJobId: job.id })
    .run();
  p.db
    .update(contents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(contents.id, contentId))
    .run();
  p.log(`retour ${input.target} sur ${contentId} → version ${revision} : « ${text} »`);
  return runSteps(p, state, account, job.id, options);
}
