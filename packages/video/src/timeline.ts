import type { ClipInfo, Edl, OverlayStyle } from '@outil/core';

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
  music: TimelineMusic | null;
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

  const music: TimelineMusic | null = o.music
    ? {
        src: o.music.src,
        volume: o.music.volume ?? 0.35,
        fadeOutFrames: Math.min(toFrames(o.edl.music.fadeOutSec, fps), durationInFrames),
      }
    : null;

  return { fps, ...OUTPUT_SIZE, durationInFrames, segments, overlays, music };
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
