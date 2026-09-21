import type { ClipInfo, Edl, EdlFraming, EffectType, OverlayStyle } from '@outil/core';

/**
 * Conversion pure EDL (secondes) → timeline Remotion (frames).
 * Aucune dépendance à React ou Remotion : testable seule.
 */

export interface TimelineSegment {
  clipId: string;
  /** URL ou chemin servi au navigateur de rendu */
  src: string;
  /** Première frame sur la timeline de sortie */
  from: number;
  durationInFrames: number;
  /** Frames dans le clip source (à la cadence de la composition) */
  startFromFrame: number;
  endAtFrame: number;
  playbackRate: number;
  framing: EdlFraming;
  /** Flou CSS en px (0 = net) */
  blur: number;
}

export interface TimelineEffect {
  type: EffectType;
  /** Frame de déclenchement sur la timeline de sortie */
  at: number;
}

export interface TimelineSfx {
  /** Son joué sur les effets  (null = muet) */
  hit: string | null;
}

export interface TimelineOverlay {
  text: string;
  style: OverlayStyle;
  from: number;
  durationInFrames: number;
}

export interface TimelineMusic {
  src: string;
  /** Volume nominal 0..1 */
  volume: number;
  fadeOutFrames: number;
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  segments: TimelineSegment[];
  overlays: TimelineOverlay[];
  effects: TimelineEffect[];
  music: TimelineMusic | null;
  sfx: TimelineSfx;
}

export const DEFAULT_FPS = 30;
export const OUTPUT_SIZE = { width: 1080, height: 1920 } as const;

const toFrames = (sec: number, fps: number) => Math.round(sec * fps);

export interface BuildTimelineOptions {
  edl: Edl;
  clips: ClipInfo[];
  /** Comment le navigateur de rendu atteint un clip (URL http locale, staticFile…) */
  srcFor: (clip: ClipInfo) => string;
  music?: { src: string; volume?: number } | null;
  sfx?: Partial<TimelineSfx>;
  fps?: number;
}

export function buildTimeline(o: BuildTimelineOptions): Timeline {
  const fps = o.fps ?? DEFAULT_FPS;
  const byId = new Map(o.clips.map((c) => [c.id, c]));

  let cursor = 0;
  const segments: TimelineSegment[] = o.edl.segments.map((s) => {
    const clip = byId.get(s.clipId);
    if (!clip) throw new Error(`clip "${s.clipId}" absent de la liste des clips`);
    const durationInFrames = Math.max(1, toFrames((s.out - s.in) / s.speed, fps));
    const seg: TimelineSegment = {
      clipId: s.clipId,
      src: o.srcFor(clip),
      from: cursor,
      durationInFrames,
      startFromFrame: toFrames(s.in, fps),
      endAtFrame: toFrames(s.out, fps),
      playbackRate: s.speed,
      framing: s.framing,
      blur: s.blur,
    };
    cursor += durationInFrames;
    return seg;
  });
  const durationInFrames = cursor;

  const overlays: TimelineOverlay[] = o.edl.overlays.map((ov) => {
    const from = Math.min(toFrames(ov.from, fps), durationInFrames - 1);
    const to = Math.min(toFrames(ov.to, fps), durationInFrames);
    return { text: ov.text, style: ov.style, from, durationInFrames: Math.max(1, to - from) };
  });

  const effects: TimelineEffect[] = o.edl.effects.map((e) => ({
    type: e.type,
    at: Math.min(toFrames(e.at, fps), durationInFrames - 1),
  }));

  const music: TimelineMusic | null = o.music
    ? {
        src: o.music.src,
        volume: o.music.volume ?? 0.35,
        fadeOutFrames: Math.min(toFrames(o.edl.music.fadeOutSec, fps), durationInFrames),
      }
    : null;

  return {
    fps,
    ...OUTPUT_SIZE,
    durationInFrames,
    segments,
    overlays,
    effects,
    music,
    sfx: { hit: o.sfx?.hit ?? null },
  };
}

/** Volume de la musique à une frame donnée (fondu de sortie linéaire). */
export function musicVolumeAt(
  frame: number,
  music: TimelineMusic,
  durationInFrames: number,
): number {
  const fadeStart = durationInFrames - music.fadeOutFrames;
  if (music.fadeOutFrames <= 0 || frame <= fadeStart) return music.volume;
  const t = Math.min(1, (frame - fadeStart) / music.fadeOutFrames);
  return music.volume * (1 - t);
}

/** Durée de l'effet « hit » en frames à 30 fps (flash, coup de zoom, étincelles). */
export const HIT_EFFECT_FRAMES = 24;

/**
 * Coup de zoom global à une frame donnée : 1 hors effet ; sur un « hit », monte à 1.12 en 4 frames
 * puis redescend à 1 sur le reste de l'effet (pur, testable).
 */
export function punchScaleAt(frame: number, effects: TimelineEffect[]): number {
  let scale = 1;
  for (const e of effects) {
    if (e.type !== 'hit') continue;
    const t = frame - e.at;
    if (t < 0 || t >= HIT_EFFECT_FRAMES) continue;
    const s = t < 4 ? 1 + 0.12 * (t / 4) : 1 + 0.12 * (1 - (t - 4) / (HIT_EFFECT_FRAMES - 4));
    scale = Math.max(scale, s);
  }
  return scale;
}

/** Opacité du flash blanc d'un « hit » : 0,85 à la frame de l'effet, 0 après 8 frames. */
export function flashOpacityAt(frame: number, effects: TimelineEffect[]): number {
  let opacity = 0;
  for (const e of effects) {
    if (e.type !== 'hit') continue;
    const t = frame - e.at;
    if (t < 0 || t >= 8) continue;
    opacity = Math.max(opacity, 0.85 * (1 - t / 8));
  }
  return opacity;
}
