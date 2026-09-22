import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { contents, loadAccount, METADATA_FILENAME, metadataSchema } from '@outil/core';
import type { PipelineContext } from './context.js';
import { loadState, saveState, type PipelineState } from './state.js';
import { thumbnail } from './steps/thumbnail.js';

/**
 * Regénère les miniatures d'un contenu déjà livré (après un changement de gabarit ou de style),
 * sans refaire dérushage, montage ni rendu. Les copies de /processing ayant disparu à la
 * livraison, les rushs sont relus depuis leur dossier d'origine (`sourceDir`, dans /raw).
 */
export async function regenerateThumbnails(
  p: PipelineContext,
  contentId: string,
): Promise<PipelineState> {
  const row = p.db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!row) throw new Error(`contenu inconnu : ${contentId}`);
  const readyDir = p.ctx.paths.ready(row.account, contentId);
  const state = loadState(path.join(readyDir, 'work'));
  if (!state.deliveredDir) throw new Error(`${contentId} n'est pas encore livré`);
  const account = loadAccount(state.account, p.ctx.accountsDir);

  state.clips = (state.clips ?? []).map((c) => {
    const raw = path.join(state.sourceDir, path.basename(c.path));
    if (!fs.existsSync(raw)) throw new Error(`rush d'origine introuvable : ${raw}`);
    return { ...c, path: raw };
  });
  const previous = state.thumbnails ?? [];

  await thumbnail(p, state, account);

  // Les nouvelles miniatures remplacent les anciennes à côté de la vidéo
  for (const t of previous) fs.rmSync(t.path, { force: true });
  state.thumbnails = (state.thumbnails ?? []).map((t) => {
    const dest = path.join(readyDir, path.basename(t.path));
    fs.renameSync(t.path, dest);
    return { ...t, path: dest };
  });

  const metaFile = path.join(readyDir, METADATA_FILENAME);
  const metadata = metadataSchema.parse(JSON.parse(fs.readFileSync(metaFile, 'utf8')));
  metadata.thumbnails = state.thumbnails.map((t) => ({
    path: path.basename(t.path),
    format: t.format,
    variant: t.variant,
    selected: t.selected,
  }));
  const aiImages = state.thumbnails.some((t) => t.background === 'ai');
  metadata.aiDisclosure.images = aiImages;
  if (aiImages && !metadata.aiDisclosure.providers.includes('kie')) {
    metadata.aiDisclosure.providers.push('kie');
  }
  fs.writeFileSync(metaFile, JSON.stringify(metadataSchema.parse(metadata), null, 2));
  saveState(state);
  p.log(`miniatures regénérées : ${readyDir}`);
  return state;
}
