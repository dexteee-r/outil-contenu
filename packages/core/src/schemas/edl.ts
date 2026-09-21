import { z } from 'zod';
import type { ClipInfo } from './tagging.js';

/**
 * Contrat EDL (Edit Decision List) — étape `edl`, produit par Claude, consommé par Remotion.
 * Schéma verrouillé : tous les champs requis, pas de défauts (sorties structurées).
 *
 * Temps : `in`/`out` sont des secondes dans le clip source ; `from`/`to` des overlays sont
 * des secondes sur la timeline de sortie (après application des vitesses).
 */

export const EDL_VERSION = 1 as const;

export const OVERLAY_STYLES = ['hook', 'callout', 'caption'] as const;
export type OverlayStyle = (typeof OVERLAY_STYLES)[number];

const seconds = z.number().nonnegative();

/** Cadrage d'un segment : zoom (1 = plein cadre) centré sur un point de l'image (fractions 0..1). */
export const edlFramingSchema = z
  .object({
    zoom: z.number().min(1).max(2.5),
    focusX: z.number().min(0).max(1),
    focusY: z.number().min(0).max(1),
  })
  .strict();
export type EdlFraming = z.infer<typeof edlFramingSchema>;

export const edlSegmentSchema = z
  .object({
    clipId: z.string().min(1),
    in: seconds,
    out: seconds,
    speed: z.number().min(0.5).max(2), // 1 = vitesse normale
    framing: edlFramingSchema,
    /** Flou en pixels (0 = net) : sert à teaser le climax sans le révéler */
    blur: z.number().min(0).max(40),
  })
  .strict();
export type EdlSegment = z.infer<typeof edlSegmentSchema>;

export const edlOverlaySchema = z
  .object({
    text: z.string().min(1).max(80),
    style: z.enum(OVERLAY_STYLES),
    from: seconds,
    to: seconds,
  })
  .strict();
export type EdlOverlay = z.infer<typeof edlOverlaySchema>;

export const edlMusicSchema = z
  .object({
    mood: z.string().min(1), // doit exister dans music.json / musicMoods du compte
    tempoRange: z
      .object({ min: z.number().int().positive(), max: z.number().int().positive() })
      .strict(),
    fadeOutSec: seconds,
  })
  .strict();
export type EdlMusic = z.infer<typeof edlMusicSchema>;

export const EFFECT_TYPES = ['hit'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** Événement ponctuel sur la timeline de sortie :  = flash + coup de zoom + étincelles + son. */
export const edlEffectSchema = z
  .object({
    type: z.enum(EFFECT_TYPES),
    at: seconds,
  })
  .strict();
export type EdlEffect = z.infer<typeof edlEffectSchema>;

export const edlSchema = z
  .object({
    version: z.literal(EDL_VERSION),
    targetDurationSec: z.number().positive(),
    segments: z.array(edlSegmentSchema).min(1),
    overlays: z.array(edlOverlaySchema),
    effects: z.array(edlEffectSchema),
    music: edlMusicSchema,
    notes: z.string(), // justification courte du montage, utile pour le feedback
  })
  .strict();
export type Edl = z.infer<typeof edlSchema>;

export function segmentDurationSec(segment: EdlSegment): number {
  return (segment.out - segment.in) / segment.speed;
}

/** Durée de la vidéo de sortie, en secondes. */
export function edlDurationSec(edl: Edl): number {
  return edl.segments.reduce((sum, s) => sum + segmentDurationSec(s), 0);
}

export interface EdlIssue {
  path: string;
  message: string;
}

export interface EdlValidationOptions {
  clips: ClipInfo[];
  durationRange: { min: number; max: number };
  /** Plafond de segments (défaut 40) */
  maxSegments?: number;
  /** Durée minimale d'un segment après vitesse (défaut 0.5 s) : évite les coupes flash */
  minSegmentSec?: number;
  /** Tolérance sur les bornes, pour les arrondis (défaut 0.05 s) */
  toleranceSec?: number;
}

export type EdlValidation =
  | { ok: true; totalDurationSec: number; issues: [] }
  | { ok: false; totalDurationSec: number; issues: EdlIssue[] };

/**
 * Couche de contrôle du cahier : rejette un EDL invalide (timestamp hors plage, clip inexistant,
 * durée hors plage…) pour le renvoyer au modèle avec la liste des problèmes.
 * Pure : aucune I/O. Suppose `edl` déjà passé par `edlSchema`.
 */
export function validateEdl(edl: Edl, options: EdlValidationOptions): EdlValidation {
  const maxSegments = options.maxSegments ?? 40;
  const minSegmentSec = options.minSegmentSec ?? 0.5;
  const tol = options.toleranceSec ?? 0.05;
  const byId = new Map(options.clips.map((c) => [c.id, c]));
  const issues: EdlIssue[] = [];

  if (edl.segments.length > maxSegments) {
    issues.push({
      path: 'segments',
      message: `${edl.segments.length} segments, maximum ${maxSegments}`,
    });
  }

  edl.segments.forEach((s, i) => {
    const path = `segments[${i}]`;
    const clip = byId.get(s.clipId);
    if (!clip) {
      issues.push({
        path,
        message: `clipId "${s.clipId}" inconnu (clips : ${[...byId.keys()].join(', ')})`,
      });
      return;
    }
    if (s.in >= s.out) {
      issues.push({ path, message: `in (${s.in}) doit être < out (${s.out})` });
      return;
    }
    if (s.out > clip.durationSec + tol) {
      issues.push({
        path,
        message: `out (${s.out}) dépasse la durée du clip "${s.clipId}" (${clip.durationSec} s)`,
      });
    }
    const dur = segmentDurationSec(s);
    if (dur < minSegmentSec - tol) {
      issues.push({
        path,
        message: `segment trop court (${dur.toFixed(2)} s, minimum ${minSegmentSec} s)`,
      });
    }
  });

  const totalDurationSec = edlDurationSec(edl);
  const { min, max } = options.durationRange;
  if (totalDurationSec < min - tol || totalDurationSec > max + tol) {
    issues.push({
      path: 'segments',
      message: `durée totale ${totalDurationSec.toFixed(2)} s hors plage [${min}, ${max}] s`,
    });
  }

  const sorted = edl.overlays.map((o, i) => ({ o, i })).sort((a, b) => a.o.from - b.o.from);
  for (const { o, i } of sorted) {
    const path = `overlays[${i}]`;
    if (o.from >= o.to) issues.push({ path, message: `from (${o.from}) doit être < to (${o.to})` });
    if (o.to > totalDurationSec + tol) {
      issues.push({
        path,
        message: `to (${o.to}) dépasse la durée de sortie (${totalDurationSec.toFixed(2)} s)`,
      });
    }
  }
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1]!;
    const cur = sorted[k]!;
    if (cur.o.from < prev.o.to - tol) {
      issues.push({
        path: `overlays[${cur.i}]`,
        message: `chevauche overlays[${prev.i}] (${prev.o.from}-${prev.o.to} s)`,
      });
    }
  }

  edl.effects.forEach((e, i) => {
    if (e.at > totalDurationSec + tol) {
      issues.push({
        path: `effects[${i}]`,
        message: `at (${e.at}) dépasse la durée de sortie (${totalDurationSec.toFixed(2)} s)`,
      });
    }
  });

  return issues.length === 0
    ? { ok: true, totalDurationSec, issues: [] }
    : { ok: false, totalDurationSec, issues };
}

/** Liste lisible des problèmes, à renvoyer au modèle pour correction. */
export function formatEdlIssues(issues: EdlIssue[]): string {
  return issues.map((i) => `- ${i.path}: ${i.message}`).join('\n');
}
