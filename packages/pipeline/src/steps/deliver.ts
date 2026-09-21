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
    version: 1,
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
 * Livraison : déplace vidéo et miniatures dans /ready/<compte>/<content-id>/, écrit metadata.json,
 * archive les fichiers de travail (tagging, EDL, état) dans work/, supprime /processing/<id>.
 */
export function deliver(p: PipelineContext, state: PipelineState): void {
  if (!state.render) throw new Error('deliver : rendu manquant');
  const readyDir = p.ctx.paths.ready(state.account, state.contentId);
  fs.mkdirSync(path.join(readyDir, 'work'), { recursive: true });

  const videoName = 'video.mp4';
  fs.copyFileSync(state.render.path, path.join(readyDir, videoName));
  const thumbnails = (state.thumbnails ?? []).map((t) => {
    const name = path.basename(t.path);
    fs.copyFileSync(t.path, path.join(readyDir, name));
    return { path: name, format: t.format, variant: t.variant, selected: t.selected };
  });
  for (const work of ['tagging.json', 'edl.json', 'key-frame.png', 'thumb-background.png']) {
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
    .set({ status: 'ready', updatedAt: new Date().toISOString() })
    .where(eq(contents.id, state.contentId))
    .run();
  p.log(`deliver : ${readyDir}`);
}
