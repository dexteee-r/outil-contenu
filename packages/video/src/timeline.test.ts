import { loadReferenceClips, loadReferenceEdl } from '@outil/core';
import { describe, expect, it } from 'vitest';
import { buildTimeline, musicVolumeAt } from './timeline';

const clips = loadReferenceClips();
const edl = loadReferenceEdl();
const srcFor = (c: { id: string }) => `http://127.0.0.1:1/clips/${c.id}.mp4`;

describe('buildTimeline', () => {
  it('convertit les secondes en frames en tenant compte de la vitesse', () => {
    const t = buildTimeline({ edl, clips, srcFor, fps: 30 });
    expect(t.fps).toBe(30);
    expect([t.width, t.height]).toEqual([1080, 1920]);
    // segment 2 : 6.0→10.0 s à 1.5x = 2.667 s → 80 frames ; source 180→300
    expect(t.segments[1]).toEqual({
      clipId: 'rush-01',
      src: 'http://127.0.0.1:1/clips/rush-01.mp4',
      from: 75,
      durationInFrames: 80,
      startFromFrame: 180,
      endAtFrame: 300,
      playbackRate: 1.5,
    });
    // les segments s'enchaînent sans trou
    for (let i = 1; i < t.segments.length; i++) {
      expect(t.segments[i]!.from).toBe(
        t.segments[i - 1]!.from + t.segments[i - 1]!.durationInFrames,
      );
    }
    expect(t.durationInFrames).toBe(t.segments.reduce((s, x) => s + x.durationInFrames, 0));
    expect(t.durationInFrames).toBe(770); // 25.667 s × 30
  });

  it('place les overlays en frames et les borne à la durée', () => {
    const t = buildTimeline({ edl, clips, srcFor, fps: 30 });
    expect(t.overlays[0]).toEqual({
      text: 'Il sort QUOI de ce booster ?!',
      style: 'hook',
      from: 0,
      durationInFrames: 75,
    });
    const late = buildTimeline({
      edl: { ...edl, overlays: [{ text: 'fin', style: 'caption', from: 25, to: 99 }] },
      clips,
      srcFor,
      fps: 30,
    });
    expect(late.overlays[0]!.from + late.overlays[0]!.durationInFrames).toBe(770);
  });

  it('branche la musique avec un fondu en frames, ou null', () => {
    const withMusic = buildTimeline({ edl, clips, srcFor, music: { src: 'm.mp3' } });
    expect(withMusic.music).toEqual({ src: 'm.mp3', volume: 0.35, fadeOutFrames: 45 });
    expect(buildTimeline({ edl, clips, srcFor }).music).toBeNull();
  });

  it('refuse un clip inconnu', () => {
    expect(() =>
      buildTimeline({
        edl: { ...edl, segments: [{ clipId: 'x', in: 0, out: 1, speed: 1 }] },
        clips,
        srcFor,
      }),
    ).toThrow(/clip "x"/);
  });
});

describe('musicVolumeAt', () => {
  const music = { src: 'm', volume: 0.5, fadeOutFrames: 30 };
  it('reste au volume nominal puis décroît linéairement jusqu’à 0', () => {
    expect(musicVolumeAt(0, music, 300)).toBe(0.5);
    expect(musicVolumeAt(270, music, 300)).toBe(0.5);
    expect(musicVolumeAt(285, music, 300)).toBeCloseTo(0.25);
    expect(musicVolumeAt(300, music, 300)).toBe(0);
  });
});
