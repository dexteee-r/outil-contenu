import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  briefSection,
  extractFrame,
  loadPrompt,
  sharpness,
  type AnthropicContentBlock,
  type LoadedAccount,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import { currentFeedback, type PipelineState } from '../state.js';
import { readBrief } from './ingest.js';

/**
 * Couverture « screen » : une image tirée de la vidéo, comme sur Instagram. Des captures nettes
 * et variées sont extraites des passages retenus au montage, puis Claude les regarde et choisit
 * celle qu'un créateur prendrait (sujet net, grand, centré, qui raconte la vidéo). La netteté
 * mesurée seule ne suffit pas : elle préfère un écran couvert de texte à un PC allumé dans le noir.
 */

const execFileAsync = promisify(execFile);

export interface CoverSample {
  clipId: string;
  atSec: number;
  /** Index du segment de montage d'où vient l'instant */
  segment: number;
}

export interface ScoredSample extends CoverSample {
  sharpness: number;
  file: string;
}

/** Instants à tester : tous les 0,4 s dans chaque passage du montage (10 au plus par passage). */
export function coverSampleTimes(
  segments: { clipId: string; in: number; out: number }[],
  step = 0.4,
  perSegment = 10,
): CoverSample[] {
  const out: CoverSample[] = [];
  segments.forEach((s, segment) => {
    const start = s.in + 0.15;
    const end = s.out - 0.15;
    if (end <= start) {
      out.push({ clipId: s.clipId, atSec: (s.in + s.out) / 2, segment });
      return;
    }
    const n = Math.min(perSegment, Math.floor((end - start) / step) + 1);
    const gap = n > 1 ? (end - start) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      out.push({ clipId: s.clipId, atSec: Math.round((start + i * gap) * 100) / 100, segment });
    }
  });
  return out;
}

/**
 * Les captures montrées à Claude : les 2 plus nettes de chaque passage (à 1 s d'écart au moins,
 * pour la variété), puis les `max` plus nettes de l'ensemble, remises dans l'ordre de la vidéo.
 */
export function selectCoverCandidates<T extends ScoredSample>(
  scored: T[],
  max = 12,
  perSegment = 2,
  minGapSec = 1,
): T[] {
  const bySegment = new Map<number, T[]>();
  for (const s of scored) bySegment.set(s.segment, [...(bySegment.get(s.segment) ?? []), s]);
  const kept: T[] = [];
  for (const list of bySegment.values()) {
    const picked: T[] = [];
    for (const s of [...list].sort((a, b) => b.sharpness - a.sharpness)) {
      if (picked.length >= perSegment) break;
      if (picked.every((p) => p.clipId !== s.clipId || Math.abs(p.atSec - s.atSec) >= minGapSec)) {
        picked.push(s);
      }
    }
    kept.push(...picked);
  }
  return kept
    .sort((a, b) => b.sharpness - a.sharpness)
    .slice(0, max)
    .sort((a, b) => a.segment - b.segment || a.atSec - b.atSec);
}

const choiceSchema = z.object({
  index: z.number().int().min(1),
  why: z.string().min(1).max(400),
});

export interface CoverChoice {
  clipId: string;
  atSec: number;
  /** Image pleine résolution (PNG) */
  frame: Buffer;
  why: string;
}

/** Petite capture JPEG (480 px de large) : assez pour juger, légère à envoyer. */
async function smallFrame(clipPath: string, atSec: number, out: string): Promise<string> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    clipPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=480:-2',
    '-q:v',
    '3',
    out,
  ]);
  return out;
}

export async function pickCover(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<CoverChoice> {
  const clips = state.clips ?? [];
  const clipById = new Map(clips.map((c) => [c.id, c]));
  // Passages du montage ; sans montage, les rushs entiers
  const segments =
    state.edl?.segments.filter((s) => clipById.has(s.clipId)) ??
    clips.map((c) => ({ clipId: c.id, in: 0, out: c.durationSec }));
  const dir = path.join(state.workDir, 'cover-candidates');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const scored: ScoredSample[] = [];
  for (const [i, s] of coverSampleTimes(segments).entries()) {
    const clip = clipById.get(s.clipId)!;
    const file = await smallFrame(clip.path, s.atSec, path.join(dir, `s${i}.jpg`));
    scored.push({ ...s, file, sharpness: await sharpness(file) });
  }
  const candidates = selectCoverCandidates(scored);
  if (candidates.length === 0) throw new Error('couverture : aucune capture');

  let chosen = [...candidates].sort((a, b) => b.sharpness - a.sharpness)[0]!;
  let why = 'la plus nette (choix automatique)';
  try {
    const model = p.ctx.env.MODEL_CAPTIONS;
    const feedback = currentFeedback(state, 'thumbnail');
    const content: AnthropicContentBlock[] = [
      {
        type: 'text',
        text: [
          `Compte : ${account.config.displayName} (${account.config.contentType}).`,
          briefSection(readBrief(state.sourceDir)),
          state.tagging ? `Résumé de la vidéo : ${state.tagging.summary}` : '',
          state.thumbnailSubject ? `Sujet principal : ${state.thumbnailSubject.what}` : '',
          feedback ? `Retour de Markus sur la couverture précédente : « ${feedback.text} »` : '',
          `Voici ${candidates.length} captures, dans l'ordre de la vidéo.`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    candidates.forEach((c, i) => {
      content.push({ type: 'text', text: `Image ${i + 1}` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: fs.readFileSync(c.file).toString('base64'),
        },
      });
    });
    const { data } = await p.anthropic().generateStructured({
      model,
      schema: choiceSchema,
      system: loadPrompt('cover-pick', p.ctx.promptsDir),
      messages: [{ role: 'user', content }],
      meta: {
        module: 'image',
        provider: 'anthropic',
        model,
        account: state.account,
        contentId: state.contentId,
      },
      maxTokens: 2000,
      effort: 'low',
    });
    const picked = candidates[data.index - 1];
    if (picked) {
      chosen = picked;
      why = data.why;
    } else {
      p.log(`couverture : numéro ${data.index} hors liste — image la plus nette à la place`);
    }
  } catch (err) {
    p.log(
      `couverture : choix par Claude impossible (${err instanceof Error ? err.message : String(err)}) — image la plus nette`,
    );
  }

  const clip = clipById.get(chosen.clipId)!;
  const full = await extractFrame(clip.path, chosen.atSec, path.join(dir, 'cover.png'));
  const frame = fs.readFileSync(full);
  fs.rmSync(dir, { recursive: true, force: true });
  p.log(
    `couverture : ${chosen.clipId} @ ${chosen.atSec.toFixed(1)} s parmi ${candidates.length} captures — ${why}`,
  );
  return { clipId: chosen.clipId, atSec: chosen.atSec, frame, why };
}
