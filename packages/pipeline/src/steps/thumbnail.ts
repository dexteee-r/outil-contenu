import fs from 'node:fs';
import path from 'node:path';
import {
  composeCardThumbnail,
  composePosterThumbnail,
  composeScreenThumbnail,
  composeThumbnail,
  cropByFraming,
  DEFAULT_THUMBNAIL_TEMPLATE,
  parseThumbnailTemplate,
  pickSharpestFrame,
  THUMBNAIL_FORMATS,
  type Edl,
  type EdlFraming,
  type Highlight,
  type LoadedAccount,
  type TaggingResult,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

/** Le climax au meilleur score, sinon le meilleur moment fort, sinon null. */
export function pickKeyMoment(tagging: TaggingResult): Highlight | null {
  const sorted = [...tagging.highlights].sort((a, b) => b.score - a.score);
  return sorted.find((h) => h.kind === 'climax') ?? sorted[0] ?? null;
}

/** Instants candidats pour l'image clé : la fin du moment (présentation à la caméra) avant le début. */
export function keyFrameCandidates(moment: Highlight, clipDurationSec: number): number[] {
  const end = Math.min(moment.end, clipDurationSec - 0.1);
  const span = Math.max(0, end - moment.start);
  return [end - 0.3, end - 0.8, moment.start + span * 0.6, moment.start + Math.min(1, span / 2)]
    .map((t) => Math.min(end, Math.max(moment.start, t)))
    .filter((t) => t >= 0);
}

/** Zoom max appliqué à l'image clé : la vignette doit montrer l'objet entier, pas un détail. */
export const KEY_FRAME_MAX_ZOOM = 1.3;

/** Cadrage du segment EDL qui couvre l'instant (même point de focus que la vidéo, zoom plafonné), sinon plein cadre. */
export function framingAt(edl: Edl | undefined, clipId: string, atSec: number): EdlFraming {
  const seg = edl?.segments.find((s) => s.clipId === clipId && s.in <= atSec && atSec <= s.out);
  if (!seg) return { zoom: 1, focusX: 0.5, focusY: 0.5 };
  return { ...seg.framing, zoom: Math.min(seg.framing.zoom, KEY_FRAME_MAX_ZOOM) };
}

/**
 * Prompt de visuel de fond (style photo, généré par IA) : la scène du climax + la charte du compte.
 * En anglais, structuré sujet → cadrage → lumière/couleurs → style → interdits, comme le
 * recommande prompts/visual-prompt-engineer.md ; jamais de texte ni de reproduction d'illustration officielle.
 */
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
  const styleByType: Record<string, string> = {
    'tcg-opening':
      'vibrant collector energy, card-pull excitement, fan-style original art inspired by trading-card aesthetics',
    'nature-walk': 'natural light, calm and immersive, documentary photography feel',
    generic: 'clean modern social-media visual',
  };
  return [
    `Vertical thumbnail visual for a short-form video. Subject: ${subject}.`,
    'Composition: tight, dramatic framing on the subject, clear negative space in the lower third for a text overlay added later.',
    `Lighting and palette: high-contrast lighting, dark background, accents in ${colors.primary} and ${colors.secondary}.`,
    `Style: ${styleByType[account.config.contentType] ?? styleByType.generic}, cinematic product-photography look.`,
    'Aspect ratio 9:16.',
    'Avoid: any text, letters or logos in the image; photorealistic reproduction of official trading-card artwork, exact character designs or brand logos.',
  ].join(' ');
}

/**
 * Miniatures : une variante × deux formats.
 * - style `card` (défaut) : l'image réelle du moment clé — la plus nette parmi plusieurs instants,
 *   recadrée avec le zoom du montage — en vignette sur fond de marque, titre et appel à l'action.
 * - style `photo` : visuel plein cadre généré (kie.ai) ou image clé en repli, voile + titre.
 */
export async function thumbnail(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<void> {
  const { tagging, clips } = state;
  if (!tagging || !clips) throw new Error('thumbnail : tagging manquant');
  const title = state.thumbnailTitle ?? account.config.displayName;
  const template = fs.existsSync(account.files.thumbnailTemplate)
    ? parseThumbnailTemplate(JSON.parse(fs.readFileSync(account.files.thumbnailTemplate, 'utf8')))
    : DEFAULT_THUMBNAIL_TEMPLATE;
  const logo =
    account.files.logo && fs.existsSync(account.files.logo)
      ? fs.readFileSync(account.files.logo)
      : undefined;

  // 1. Sujet : celui choisi par Claude à l'étape captions (produit, carte, visage…), sinon le climax
  const subject = state.thumbnailSubject;
  const moment = pickKeyMoment(tagging);
  const clip =
    (subject ? clips.find((c) => c.id === subject.clipId) : undefined) ??
    (moment ? clips.find((c) => c.id === moment.clipId) : undefined) ??
    clips[0];
  if (!clip) throw new Error('thumbnail : aucun clip');
  const candidates = subject
    ? [subject.atSec, subject.atSec - 0.25, subject.atSec + 0.25, subject.atSec + 0.5].filter(
        (t) => t >= 0 && t <= clip.durationSec - 0.05,
      )
    : moment
      ? keyFrameCandidates(moment, clip.durationSec)
      : [clip.durationSec / 2];
  if (subject) p.log(`thumbnail : sujet choisi — ${subject.what}`);
  const best = await pickSharpestFrame(clip.path, candidates, path.join(state.workDir, 'frames'));
  const framing = framingAt(state.edl, clip.id, best.atSec);
  const keyFrame = await cropByFraming(best.path, framing);
  const framePath = path.join(state.workDir, 'key-frame.png');
  fs.writeFileSync(framePath, keyFrame);
  fs.rmSync(path.join(state.workDir, 'frames'), { recursive: true, force: true });
  p.log(
    `thumbnail : image clé ${clip.id} @ ${best.atSec.toFixed(1)} s (netteté ${best.sharpness.toFixed(1)}, zoom ${framing.zoom})`,
  );

  state.thumbnails = [];
  if (template.style === 'poster') {
    // Détourage du sujet (kie.ai) : c'est lui qui donne le rendu « miniature moderne »
    let hero = keyFrame;
    const kieProvider = p.kie();
    if (kieProvider) {
      try {
        const cut = await kieProvider.removeBackground(keyFrame, {
          module: 'image',
          provider: 'kie',
          model: 'recraft/remove-background',
          account: state.account,
          contentId: state.contentId,
        });
        hero = cut.image;
        fs.writeFileSync(path.join(state.workDir, 'cutout.png'), hero);
        p.log(`thumbnail : sujet détouré (${cut.costUsd.toFixed(3)} $)`);
      } catch (err) {
        p.log(
          `thumbnail : détourage indisponible (${err instanceof Error ? err.message : String(err)}) — sujet non détouré`,
        );
      }
    }
    for (const format of THUMBNAIL_FORMATS) {
      const composed = await composePosterThumbnail({
        subject: hero,
        format,
        template,
        brand: account.config.brand,
        title,
        logo,
      });
      const file = path.join(state.workDir, `thumb-${format}-v1.png`);
      fs.writeFileSync(file, composed.png);
      state.thumbnails.push({
        path: file,
        format,
        variant: 1,
        selected: true,
        background: 'frame',
      });
    }
    p.log(`thumbnail : style poster, titre « ${title} », CTA « ${template.cta ?? '—'} »`);
    return;
  }

  if (template.style === 'screen' || template.style === 'card') {
    for (const format of THUMBNAIL_FORMATS) {
      const composed =
        template.style === 'screen'
          ? await composeScreenThumbnail({
              frame: keyFrame,
              format,
              template,
              brand: account.config.brand,
              title,
              logo,
            })
          : await composeCardThumbnail({
              keyFrame,
              format,
              template,
              brand: account.config.brand,
              title,
              logo,
            });
      const file = path.join(state.workDir, `thumb-${format}-v1.png`);
      fs.writeFileSync(file, composed.png);
      state.thumbnails.push({
        path: file,
        format,
        variant: 1,
        selected: true,
        background: 'frame',
      });
    }
    p.log(
      `thumbnail : style ${template.style}, titre « ${title} », CTA « ${template.cta ?? '—'} »`,
    );
    return;
  }

  // 2. Style photo : fond IA si disponible, sinon l'image clé
  let background = keyFrame;
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
    }
  }
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
  p.log(`thumbnail : style photo (${source}), titre « ${title} »`);
}
