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

/** Sons de la bibliothèque sfx/ disponibles pour le rendu (URL servie + durée du fichier). */
export interface SfxSource {
  src: string;
  durationSec: number;
}
export type SfxKind = 'hit' | 'riser' | 'whoosh' | 'pop';
export type SfxSources = Partial<Record<SfxKind, SfxSource | null>>;

/** Un son placé sur la timeline de sortie. */
export interface SfxCue {
  kind: SfxKind;
  src: string;
  from: number;
  durationInFrames: number;
  /** Frames sautées au début du fichier (montée de tension raccourcie) */
  startFromFrame: number;
  volume: number;
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
  sfx: SfxCue[];
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
  sfx?: SfxSources;
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
    sfx: buildSfxCues({ segments, overlays, effects, durationInFrames, fps, sources: o.sfx ?? {} }),
  };
}

/**
 * Habillage sonore automatique, sans rien demander à l'EDL :
 * - hit : à chaque effet « hit », joué en entier (3 s max) ;
 * - riser : montée de tension qui se termine pile sur le hit (début du fichier sauté si la place manque) ;
 * - whoosh : à chaque changement de plan, un peu avant la coupe — sauf près d'un hit (il a son
 *   propre son), pendant une montée de tension, ou moins de 0,6 s après le whoosh précédent ;
 * - pop : à l'apparition de chaque texte.
 */
export function buildSfxCues(o: {
  segments: TimelineSegment[];
  overlays: TimelineOverlay[];
  effects: TimelineEffect[];
  durationInFrames: number;
  fps: number;
  sources: SfxSources;
}): SfxCue[] {
  const { fps, sources } = o;
  const cues: SfxCue[] = [];
  const add = (kind: SfxKind, from: number, maxSec: number, volume: number, startFromFrame = 0) => {
    const s = sources[kind];
    if (!s) return;
    const start = Math.max(0, from);
    const length = Math.min(
      toFrames(Math.min(s.durationSec, maxSec), fps) - startFromFrame,
      o.durationInFrames - start,
    );
    if (length > 0)
      cues.push({
        kind,
        src: s.src,
        from: start,
        durationInFrames: length,
        startFromFrame,
        volume,
      });
  };

  const hits = o.effects.filter((e) => e.type === 'hit').map((e) => e.at);
  const riserWindows: [number, number][] = [];
  for (const at of hits) {
    add('hit', at, 3, 0.75); // 0,9 saturait presque avec la musique (pic à -0,2 dBFS)
    const riser = sources.riser;
    if (riser) {
      const full = toFrames(riser.durationSec, fps);
      const len = Math.min(full, at);
      if (len >= toFrames(0.5, fps)) {
        add('riser', at - len, riser.durationSec, 0.45, full - len);
        riserWindows.push([at - len, at]);
      }
    }
  }

  const lead = toFrames(0.15, fps);
  const minGap = toFrames(0.6, fps);
  let lastWhoosh = -Infinity;
  for (const seg of o.segments.slice(1)) {
    const cut = seg.from;
    if (hits.some((at) => Math.abs(cut - at) < toFrames(0.4, fps))) continue;
    if (riserWindows.some(([a, b]) => cut >= a && cut <= b)) continue;
    if (cut - lastWhoosh < minGap) continue;
    add('whoosh', cut - lead, 1.2, 0.35);
    lastWhoosh = cut;
  }

  for (const ov of o.overlays) add('pop', ov.from, 1, 0.5);
  return cues.sort((a, b) => a.from - b.from);
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
