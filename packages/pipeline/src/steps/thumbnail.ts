import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  composeThumbnail,
  DEFAULT_THUMBNAIL_TEMPLATE,
  parseThumbnailTemplate,
  THUMBNAIL_FORMATS,
  type Highlight,
  type LoadedAccount,
  type TaggingResult,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

const execFileAsync = promisify(execFile);

/** Le climax au meilleur score, sinon le meilleur moment fort, sinon null. */
export function pickKeyMoment(tagging: TaggingResult): Highlight | null {
  const sorted = [...tagging.highlights].sort((a, b) => b.score - a.score);
  return sorted.find((h) => h.kind === 'climax') ?? sorted[0] ?? null;
}

/** Extrait une image PNG du clip à l'instant donné (ffmpeg). */
export async function extractFrame(clipPath: string, atSec: number, out: string): Promise<string> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    atSec.toFixed(3),
    '-i',
    clipPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    out,
  ]);
  return out;
}

/** Prompt de visuel de fond : la scène du climax + la charte du compte, sans texte. */
export function buildBackgroundPrompt(
  account: LoadedAccount,
  tagging: TaggingResult,
  moment: Highlight | null,
): string {
  const clip = moment ? tagging.clips.find((c) => c.id === moment.clipId) : undefined;
  const scene =
    clip?.scenes.find((s) => moment && s.start <= moment.start && s.end >= moment.start) ??
    clip?.scenes[0];
  const subject = scene?.description ?? tagging.summary;
  const colors = account.config.brand.colors;
  return `Visuel de miniature vertical pour une vidéo courte. Sujet : ${subject}. Cadrage serré et dramatique, éclairage contrasté, fond sombre, ambiance aux couleurs ${colors.primary} et ${colors.secondary}, style photo de produit cinématographique. Aucun texte, aucune lettre, aucun logo dans l'image.`;
}

/**
 * Miniature du walking skeleton : une variante × deux formats. Le fond est généré par l'IA
 * (kie.ai) quand le fournisseur est configuré, sinon c'est l'image réelle du climax. Le titre vient
 * de l'étape captions et est posé par code sur le gabarit du compte.
 */
export async function thumbnail(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<void> {
  const { tagging, clips } = state;
  if (!tagging || !clips) throw new Error('thumbnail : tagging manquant');
  const title = state.thumbnailTitle ?? account.config.displayName;

  // 1. Image réelle du moment clé : toujours extraite (repli, et base de l'image-to-image de l'étape 5)
  const moment = pickKeyMoment(tagging);
  const clip = moment ? clips.find((c) => c.id === moment.clipId) : clips[0];
  const framePath = path.join(state.workDir, 'key-frame.png');
  if (clip) {
    const at = moment
      ? moment.start + Math.min(1, (moment.end - moment.start) / 2)
      : clip.durationSec / 2;
    await extractFrame(clip.path, Math.min(at, Math.max(0, clip.durationSec - 0.1)), framePath);
    p.log(`thumbnail : image clé ${clip.id} @ ${at.toFixed(1)} s`);
  }

  // 2. Fond : IA si disponible, sinon l'image clé
  let background: Buffer;
  let source: 'ai' | 'frame' = 'frame';
  const kie = p.kie();
  const model = p.ctx.env.MODEL_IMAGE;
  if (kie && model) {
    try {
      const r = await kie.generateImage({
        model,
        prompt: buildBackgroundPrompt(account, tagging, moment),
        aspectRatio: '9:16',
        meta: {
          module: 'image',
          provider: 'kie',
          model,
          account: state.account,
          contentId: state.contentId,
        },
      });
      background = r.image;
      source = 'ai';
      state.models = { ...state.models, image: model };
      fs.writeFileSync(path.join(state.workDir, 'thumb-background.png'), background);
      p.log(`thumbnail : visuel ${model} (${r.costUsd.toFixed(3)} $)`);
    } catch (err) {
      p.log(
        `thumbnail : génération IA échouée (${err instanceof Error ? err.message : String(err)}) — repli sur l'image clé`,
      );
      background = fs.readFileSync(framePath);
    }
  } else {
    if (!fs.existsSync(framePath))
      throw new Error('thumbnail : ni fournisseur d’images ni image clé');
    background = fs.readFileSync(framePath);
    p.log('thumbnail : pas de fournisseur d’images configuré — image clé utilisée');
  }

  // 3. Composition sur le gabarit du compte, dans les deux formats
  const template = fs.existsSync(account.files.thumbnailTemplate)
    ? parseThumbnailTemplate(JSON.parse(fs.readFileSync(account.files.thumbnailTemplate, 'utf8')))
    : DEFAULT_THUMBNAIL_TEMPLATE;
  const logo =
    account.files.logo && fs.existsSync(account.files.logo)
      ? fs.readFileSync(account.files.logo)
      : undefined;
  state.thumbnails = [];
  for (const format of THUMBNAIL_FORMATS) {
    const composed = await composeThumbnail({
      background,
      format,
      template,
      brand: account.config.brand,
      title,
      logo,
    });
    const file = path.join(state.workDir, `thumb-${format}-v1.png`);
    fs.writeFileSync(file, composed.png);
    state.thumbnails.push({ path: file, format, variant: 1, selected: true, background: source });
  }
  p.log(`thumbnail : ${state.thumbnails.length} fichiers, titre « ${title} »`);
}
