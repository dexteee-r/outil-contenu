import { loadReferenceClips, loadReferenceEdl } from '@outil/core';
import { describe, expect, it } from 'vitest';
import {
  buildSfxCues,
  buildTimeline,
  flashOpacityAt,
  HIT_EFFECT_FRAMES,
  musicVolumeAt,
  punchScaleAt,
} from './timeline';

/** Cadrage plein et net : les tests ne portent pas sur le rendu */
const NEUTRAL = { framing: { zoom: 1, focusX: 0.5, focusY: 0.5 }, blur: 0 };

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
      framing: { zoom: 1.4, focusX: 0.5, focusY: 0.5 },
      blur: 0,
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
        edl: { ...edl, segments: [{ clipId: 'x', in: 0, out: 1, speed: 1, ...NEUTRAL }] },
        clips,
        srcFor,
      }),
    ).toThrow(/clip "x"/);
  });
});

describe('habillage sonore (buildSfxCues)', () => {
  const sources = {
    hit: { src: 'hit.mp3', durationSec: 2.85 },
    riser: { src: 'riser.mp3', durationSec: 3 },
    whoosh: { src: 'whoosh.mp3', durationSec: 0.8 },
    pop: { src: 'pop.mp3', durationSec: 1.4 },
  };
  const seg = (from: number, durationInFrames: number) => ({
    clipId: 'c',
    src: 'c.mp4',
    from,
    durationInFrames,
    startFromFrame: 0,
    endAtFrame: durationInFrames,
    playbackRate: 1,
    ...NEUTRAL,
  });
  const base = {
    // coupes à 60, 75 (trop proche de la précédente), 150, 280 (dans la montée), 300 (le hit)
    segments: [seg(0, 60), seg(60, 15), seg(75, 75), seg(150, 130), seg(280, 20), seg(300, 100)],
    overlays: [{ text: 'hook', style: 'hook' as const, from: 0, durationInFrames: 60 }],
    effects: [{ type: 'hit' as const, at: 300 }],
    durationInFrames: 400,
    fps: 30,
  };

  it('hit entier, montée qui finit sur le hit, whoosh aux coupes utiles, pop sur le texte', () => {
    const cues = buildSfxCues({ ...base, sources });
    const brief = cues.map((c) => `${c.kind}@${c.from}+${c.durationInFrames}`);
    expect(brief).toEqual([
      'pop@0+30', // 1 s max
      'whoosh@55+24', // 0,15 s (5 frames) avant la coupe de 60
      'whoosh@145+24', // la coupe de 75 est trop proche de celle de 60
      'riser@210+90', // 3 s qui se terminent pile à 300 ; la coupe de 280 est dans la montée
      'hit@300+86', // 2,85 s joués en entier (plus de coupure à 0,8 s)
    ]);
    expect(cues.find((c) => c.kind === 'hit')!.volume).toBeGreaterThan(
      cues.find((c) => c.kind === 'whoosh')!.volume,
    );
  });

  it('raccourcit la montée par le début si le hit arrive tôt, l’omet sous 0,5 s', () => {
    const early = buildSfxCues({ ...base, effects: [{ type: 'hit', at: 45 }], sources });
    const riser = early.find((c) => c.kind === 'riser')!;
    expect([riser.from, riser.durationInFrames, riser.startFromFrame]).toEqual([0, 45, 45]);
    const tooEarly = buildSfxCues({ ...base, effects: [{ type: 'hit', at: 10 }], sources });
    expect(tooEarly.some((c) => c.kind === 'riser')).toBe(false);
  });

  it('sans son déclaré, rien ; un son ne dépasse jamais la fin de la vidéo', () => {
    expect(buildSfxCues({ ...base, sources: {} })).toEqual([]);
    const end = buildSfxCues({
      ...base,
      effects: [{ type: 'hit', at: 390 }],
      sources: { hit: sources.hit },
    });
    expect(end[0]!.from + end[0]!.durationInFrames).toBe(400);
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

describe('effets « hit »', () => {
  it('convertit les effets en frames et les borne à la durée', () => {
    const t = buildTimeline({ edl, clips, srcFor, fps: 30 });
    expect(t.effects).toEqual([{ type: 'hit', at: 312 }]);
    expect(t.sfx).toEqual([]); // aucun son déclaré : aucun repère
  });

  it('coup de zoom : monte à 1,12 en 4 frames puis redescend, 1 hors effet', () => {
    const effects = [{ type: 'hit' as const, at: 100 }];
    expect(punchScaleAt(50, effects)).toBe(1);
    expect(punchScaleAt(100, effects)).toBe(1);
    expect(punchScaleAt(104, effects)).toBeCloseTo(1.12);
    expect(punchScaleAt(100 + HIT_EFFECT_FRAMES - 1, effects)).toBeGreaterThan(1);
    expect(punchScaleAt(100 + HIT_EFFECT_FRAMES, effects)).toBe(1);
  });

  it('flash : 0,85 à la frame de l’effet, décroît sur 8 frames', () => {
    const effects = [{ type: 'hit' as const, at: 10 }];
    expect(flashOpacityAt(9, effects)).toBe(0);
    expect(flashOpacityAt(10, effects)).toBeCloseTo(0.85);
    expect(flashOpacityAt(14, effects)).toBeCloseTo(0.425);
    expect(flashOpacityAt(18, effects)).toBe(0);
  });
});
