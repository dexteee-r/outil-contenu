import { describe, expect, it } from 'vitest';
import { coverSampleTimes, selectCoverCandidates, type ScoredSample } from './cover.js';

describe('coverSampleTimes', () => {
  it('échantillonne chaque passage du montage, 10 instants au plus, sans en sortir', () => {
    const samples = coverSampleTimes([
      { clipId: 'a', in: 0, out: 2 },
      { clipId: 'b', in: 10, out: 30 },
      { clipId: 'c', in: 5, out: 5.2 }, // trop court : son milieu
    ]);
    const a = samples.filter((s) => s.clipId === 'a');
    expect(a.map((s) => s.atSec)).toEqual([0.15, 0.58, 1, 1.43, 1.85]);
    const b = samples.filter((s) => s.clipId === 'b');
    expect(b).toHaveLength(10);
    expect(b.every((s) => s.atSec >= 10 && s.atSec <= 30 && s.segment === 1)).toBe(true);
    expect(samples.filter((s) => s.clipId === 'c')).toEqual([
      { clipId: 'c', atSec: 5.1, segment: 2 },
    ]);
  });
});

describe('selectCoverCandidates', () => {
  const s = (segment: number, atSec: number, sharpness: number): ScoredSample => ({
    clipId: `clip${segment}`,
    segment,
    atSec,
    sharpness,
    file: `${segment}-${atSec}`,
  });

  it('2 par passage, espacées d’1 s, les plus nettes, dans l’ordre de la vidéo', () => {
    const scored = [
      s(0, 1, 50),
      s(0, 1.4, 49), // trop proche de 1 s
      s(0, 3, 40),
      s(0, 5, 10),
      s(1, 0.5, 90),
      s(1, 2, 80),
      s(1, 4, 85),
      s(2, 1, 5),
    ];
    const picked = selectCoverCandidates(scored, 4);
    expect(picked.map((p) => `${p.segment}@${p.atSec}`)).toEqual(['0@1', '0@3', '1@0.5', '1@4']);
  });
});
