import fs from 'node:fs';
import path from 'node:path';
import { contents, jobs, probeClips, type LoadedAccount } from '@outil/core';
import type { PipelineContext } from '../context.js';
import { isVideoFile, makeContentId } from '../ids.js';
import { saveState, type PipelineState } from '../state.js';

/**
 * Ingestion : un sous-dossier de /raw/<compte>/ = un contenu. Copie les rushs dans
 * /processing/<content-id>/source/, sonde chaque fichier (ffprobe) et crée l'état + les lignes
 * `contents` et `jobs`. Les originaux dans /raw ne sont jamais modifiés.
 */
export interface IngestResult {
  state: PipelineState;
  jobId: number;
}

export async function ingest(
  p: PipelineContext,
  input: { account: LoadedAccount; inputDir: string; contentId?: string },
): Promise<IngestResult> {
  const sourceDir = path.resolve(input.inputDir);
  if (!fs.existsSync(sourceDir)) throw new Error(`dossier introuvable : ${sourceDir}`);
  const sourceFiles = fs
    .readdirSync(sourceDir)
    .filter((f) => isVideoFile(f) && fs.statSync(path.join(sourceDir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  if (sourceFiles.length === 0) throw new Error(`aucun rush vidéo dans ${sourceDir}`);

  const contentId = input.contentId ?? makeContentId(input.account.config.slug, sourceDir);
  const workDir = p.ctx.paths.processing(contentId);
  const srcCopyDir = path.join(workDir, 'source');
  fs.mkdirSync(srcCopyDir, { recursive: true });

  const copied: string[] = [];
  for (const file of sourceFiles) {
    const dest = path.join(srcCopyDir, file);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(sourceDir, file), dest);
    copied.push(dest);
  }
  p.log(`ingest : ${sourceFiles.length} rush(s) copié(s) dans ${srcCopyDir}`);

  const clips = await probeClips(copied);
  for (const c of clips) {
    p.log(
      `  ${c.id} — ${c.durationSec.toFixed(1)} s, ${c.width}x${c.height}, audio ${c.hasAudio ? 'oui' : 'non'}`,
    );
  }

  const state: PipelineState = {
    version: 1,
    contentId,
    account: input.account.config.slug,
    sourceDir,
    workDir,
    createdAt: new Date().toISOString(),
    completedSteps: ['ingest'],
    sourceFiles,
    clips,
  };
  saveState(state);

  p.db
    .insert(contents)
    .values({ id: contentId, account: state.account, sourceDir, status: 'processing' })
    .onConflictDoNothing()
    .run();
  const job = p.db
    .insert(jobs)
    .values({
      contentId,
      kind: 'pipeline',
      status: 'running',
      currentStep: 'ingest',
      startedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  return { state, jobId: job.id };
}
