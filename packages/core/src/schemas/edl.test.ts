import { describe, expect, it } from 'vitest';
import { edlDurationSec, edlSchema, formatEdlIssues, validateEdl, type Edl } from './edl.js';
import { loadReferenceClips, loadReferenceEdl } from './fixtures.js';

const clips = loadReferenceClips();
const reference = loadReferenceEdl();
const range = { min: 15, max: 60 };

const withSegments = (segments: Edl['segments'], overlays: Edl['overlays'] = []): Edl => ({
  ...reference,
  segments,
  overlays,
});

describe('edlSchema', () => {
  it('accepte l’EDL de référence et refuse une clé inconnue', () => {
    expect(edlSchema.safeParse(reference).success).toBe(true);
    expect(edlSchema.safeParse({ ...reference, extra: 1 }).success).toBe(false);
  });

  it('refuse une mauvaise version, une vitesse hors bornes, un overlay trop long', () => {
    expect(edlSchema.safeParse({ ...reference, version: 2 }).success).toBe(false);
    expect(
      edlSchema.safeParse(withSegments([{ clipId: 'rush-01', in: 0, out: 5, speed: 3 }])).success,
    ).toBe(false);
    expect(
      edlSchema.safeParse({
        ...reference,
        overlays: [{ text: 'x'.repeat(81), style: 'hook', from: 0, to: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('edlDurationSec', () => {
  it('tient compte de la vitesse', () => {
    expect(edlDurationSec(withSegments([{ clipId: 'rush-01', in: 0, out: 6, speed: 1.5 }]))).toBe(
      4,
    );
    expect(edlDurationSec(reference)).toBeCloseTo(25.667, 2);
  });
});

describe('validateEdl', () => {
  it('valide l’EDL de référence', () => {
    const result = validateEdl(reference, { clips, durationRange: range });
    expect(result.ok).toBe(true);
    expect(result.totalDurationSec).toBeCloseTo(25.667, 2);
  });

  it('signale un clip inexistant', () => {
    const r = validateEdl(withSegments([{ clipId: 'rush-99', in: 0, out: 20, speed: 1 }]), {
      clips,
      durationRange: range,
    });
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.path).toBe('segments[0]');
    expect(r.issues[0]?.message).toContain('clipId "rush-99" inconnu');
  });

  it('signale in >= out et out hors du clip', () => {
    const r = validateEdl(
      withSegments([
        { clipId: 'rush-01', in: 10, out: 10, speed: 1 },
        { clipId: 'rush-02', in: 0, out: 30, speed: 1 },
      ]),
      { clips, durationRange: range },
    );
    expect(r.ok).toBe(false);
    const messages = r.issues.map((i) => `${i.path}: ${i.message}`);
    expect(
      messages.some((m) => m.startsWith('segments[0]') && m.includes('in (10) doit être < out')),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.startsWith('segments[1]') && m.includes('dépasse la durée du clip "rush-02"'),
      ),
    ).toBe(true);
  });

  it('signale une durée totale hors plage et un segment trop court', () => {
    const tooShort = validateEdl(withSegments([{ clipId: 'rush-01', in: 0, out: 5, speed: 1 }]), {
      clips,
      durationRange: range,
    });
    expect(tooShort.ok).toBe(false);
    expect(tooShort.issues[0]?.message).toContain('durée totale 5.00 s hors plage [15, 60]');

    const flash = validateEdl(
      withSegments([
        { clipId: 'rush-01', in: 0, out: 0.2, speed: 1 },
        { clipId: 'rush-01', in: 1, out: 21, speed: 1 },
      ]),
      { clips, durationRange: range },
    );
    expect(flash.ok).toBe(false);
    expect(flash.issues.map((i) => i.path)).toEqual(['segments[0]']);
    expect(flash.issues[0]?.message).toContain('trop court');
  });

  it('plafonne le nombre de segments', () => {
    const many = Array.from({ length: 5 }, (_, k) => ({
      clipId: 'rush-01',
      in: k * 4,
      out: k * 4 + 4,
      speed: 1,
    }));
    const r = validateEdl(withSegments(many), { clips, durationRange: range, maxSegments: 4 });
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toBe('5 segments, maximum 4');
  });

  it('contrôle les overlays : bornes, dépassement, chevauchement', () => {
    const segs: Edl['segments'] = [{ clipId: 'rush-01', in: 0, out: 20, speed: 1 }];
    const r = validateEdl(
      withSegments(segs, [
        { text: 'A', style: 'hook', from: 0, to: 3 },
        { text: 'B', style: 'callout', from: 2, to: 5 },
        { text: 'C', style: 'caption', from: 6, to: 6 },
        { text: 'D', style: 'caption', from: 18, to: 25 },
      ]),
      { clips, durationRange: range },
    );
    expect(r.ok).toBe(false);
    const byPath = Object.fromEntries(r.issues.map((i) => [i.path, i.message]));
    expect(byPath['overlays[1]']).toContain('chevauche overlays[0]');
    expect(byPath['overlays[2]']).toContain('from (6) doit être < to (6)');
    expect(byPath['overlays[3]']).toContain('dépasse la durée de sortie');
  });

  it('tolère les arrondis aux bornes', () => {
    const r = validateEdl(withSegments([{ clipId: 'rush-02', in: 0, out: 18.52, speed: 1 }]), {
      clips,
      durationRange: range,
    });
    expect(r.ok).toBe(true);
  });
});

describe('formatEdlIssues', () => {
  it('produit une liste à puces pour le modèle', () => {
    expect(formatEdlIssues([{ path: 'segments[0]', message: 'x' }])).toBe('- segments[0]: x');
  });
});
