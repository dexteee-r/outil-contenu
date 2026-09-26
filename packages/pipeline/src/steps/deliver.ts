import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { contents, METADATA_FILENAME, metadataSchema, type Metadata } from '@outil/core';
import type { PipelineContext } from '../context.js';
import { saveState, type PipelineState } from '../state.js';

/** Construit metadata.json à partir de l'état (pur, testable). */
export function buildMetadata(
  state: PipelineState,
  files: {
    video: string;
    thumbnails: { path: string; format: '9x16' | '16x9'; variant: number; selected: boolean }[];
  },
): Metadata {
  if (!state.render || !state.captions) throw new Error('deliver : rendu ou légendes manquants');
  const aiImages = (state.thumbnails ?? []).some((t) => t.background === 'ai');
  const providers = new Set<string>();
  if (state.models?.tagging) providers.add('gemini');
  if (state.models?.edl || state.models?.captions) providers.add('anthropic');
  if (aiImages) providers.add('kie');
  return metadataSchema.parse({
    schemaVersion: 1,
    contentId: state.contentId,
    account: state.account,
    version: state.revision ?? 1,
    createdAt: new Date().toISOString(),
    video: {
      path: files.video,
      durationSec: state.render.durationSec,
      width: state.render.width,
      height: state.render.height,
    },
    thumbnails: files.thumbnails,
    captions: state.captions,
    // Le montage est fait à partir de vraies images ; seule la miniature peut être générée
    aiDisclosure: { video: false, images: aiImages, providers: [...providers] },
    sourceFiles: state.sourceFiles,
    models: state.models ?? {},
  });
}

/**
 * Version déjà livrée dans `readyDir` (relance sur feedback) : ses fichiers partent dans
 * `v<n>/`, pour que le dossier montre toujours la dernière version et garde l'historique.
 */
export function archivePreviousVersion(readyDir: string): number | null {
  const metaFile = path.join(readyDir, METADATA_FILENAME);
  if (!fs.existsSync(metaFile)) return null;
  const { version } = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { version: number };
  const dest = path.join(readyDir, `v${version}`);
  fs.mkdirSync(dest, { recursive: true });
  const files = fs
    .readdirSync(readyDir)
    .filter((n) => n === METADATA_FILENAME || /^video\.mp4$|^thumb-.*\.png$/.test(n));
  for (const name of files) fs.renameSync(path.join(readyDir, name), path.join(dest, name));
  const edlFile = path.join(readyDir, 'work', 'edl.json');
  if (fs.existsSync(edlFile)) fs.copyFileSync(edlFile, path.join(dest, 'edl.json'));
  return version;
}

/**
 * Livraison : déplace vidéo et miniatures dans /ready/<compte>/<content-id>/, écrit metadata.json,
 * archive les fichiers de travail (tagging, EDL, état) dans work/, supprime /processing/<id>.
 * Une version précédente est d'abord rangée dans `v<n>/`.
 */
export function deliver(p: PipelineContext, state: PipelineState): void {
  if (!state.render) throw new Error('deliver : rendu manquant');
  const readyDir = p.ctx.paths.ready(state.account, state.contentId);
  const archived = archivePreviousVersion(readyDir);
  if (archived) p.log(`deliver : version ${archived} rangée dans v${archived}/`);
  fs.mkdirSync(path.join(readyDir, 'work'), { recursive: true });

  const videoName = 'video.mp4';
  fs.copyFileSync(state.render.path, path.join(readyDir, videoName));
  const thumbnails = (state.thumbnails ?? []).map((t) => {
    const name = path.basename(t.path);
    fs.copyFileSync(t.path, path.join(readyDir, name));
    return { path: name, format: t.format, variant: t.variant, selected: t.selected };
  });
  for (const work of [
    'tagging.json',
    'edl.json',
    'key-frame.png',
    'hit-frame.png',
    'thumb-background.png',
  ]) {
    const src = path.join(state.workDir, work);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(readyDir, 'work', work));
  }

  const metadata = buildMetadata(state, { video: videoName, thumbnails });
  fs.writeFileSync(path.join(readyDir, METADATA_FILENAME), JSON.stringify(metadata, null, 2));

  state.deliveredDir = readyDir;
  state.render.path = path.join(readyDir, videoName);
  state.thumbnails = (state.thumbnails ?? []).map((t) => ({
    ...t,
    path: path.join(readyDir, path.basename(t.path)),
  }));
  // L'état final vit avec le livrable ; le dossier de travail (sources copiées, proxies) disparaît
  state.workDir = path.join(readyDir, 'work');
  saveState(state);
  fs.rmSync(p.ctx.paths.processing(state.contentId), { recursive: true, force: true });

  p.db
    .update(contents)
    .set({ status: 'ready', version: state.revision ?? 1, updatedAt: new Date().toISOString() })
    .where(eq(contents.id, state.contentId))
    .run();
  p.log(`deliver : ${readyDir}`);
}
