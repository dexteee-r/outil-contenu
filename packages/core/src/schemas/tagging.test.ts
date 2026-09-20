import { describe, expect, it } from 'vitest';
import { loadReferenceClips } from './fixtures.js';
import {
  mergeTagging,
  taggingOutputSchema,
  taggingResultSchema,
  validateTaggingOutput,
  type TaggingOutput,
} from './tagging.js';

const clips = loadReferenceClips();

const output: TaggingOutput = {
  clips: [
    {
      clipId: 'rush-01',
      summary: 'Ouverture d’un booster, la carte rare sort à la fin.',
      scenes: [
        {
          start: 0,
          end: 6,
          description: 'Booster présenté à la caméra',
          tags: ['booster', 'mains'],
          audioEvents: [],
        },
        {
          start: 27.5,
          end: 33,
          description: 'La carte holographique apparaît',
          tags: ['carte', 'holo'],
          audioEvents: ['exclamation'],
        },
      ],
      transcript: [{ start: 28, end: 30, text: 'Non mais attends…' }],
    },
    {
      clipId: 'rush-02',
      summary: 'Réaction et gros plan sur la carte.',
      scenes: [
        {
          start: 0,
          end: 18.5,
          description: 'Réaction face caméra',
          tags: ['réaction'],
          audioEvents: [],
        },
      ],
      transcript: [],
    },
  ],
  highlights: [
    {
      clipId: 'rush-01',
      start: 27.5,
      end: 33,
      score: 0.95,
      kind: 'climax',
      reason: 'la carte sort',
    },
    {
      clipId: 'rush-02',
      start: 2,
      end: 8,
      score: 0.8,
      kind: 'reaction',
      reason: 'réaction sincère',
    },
  ],
  summary: 'Ouverture TCG avec un pull rare.',
};

describe('taggingOutputSchema', () => {
  it('accepte une sortie complète et refuse un score hors [0, 1] ou une clé inconnue', () => {
    expect(taggingOutputSchema.safeParse(output).success).toBe(true);
    expect(
      taggingOutputSchema.safeParse({
        ...output,
        highlights: [{ ...output.highlights[0], score: 1.2 }],
      }).success,
    ).toBe(false);
    expect(taggingOutputSchema.safeParse({ ...output, mood: 'x' }).success).toBe(false);
  });
});

describe('validateTaggingOutput', () => {
  it('ne trouve rien à redire à une sortie cohérente', () => {
    expect(validateTaggingOutput(output, clips)).toEqual([]);
  });

  it('signale clip inconnu, clip manquant, bornes hors durée et start >= end', () => {
    const bad: TaggingOutput = {
      ...output,
      clips: [
        {
          ...output.clips[0]!,
          scenes: [{ start: 40, end: 45, description: 'x', tags: [], audioEvents: [] }],
          transcript: [{ start: 5, end: 5, text: 'x' }],
        },
      ],
      highlights: [{ ...output.highlights[0]!, clipId: 'rush-77' }],
    };
    const issues = validateTaggingOutput(bad, clips);
    const text = issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    expect(text).toContain(
      'clips[0].scenes[0]: end (45) dépasse la durée du clip "rush-01" (42 s)',
    );
    expect(text).toContain('clips[0].transcript[0]: start (5) doit être < end (5)');
    expect(text).toContain('clips: clip "rush-02" absent de la sortie');
    expect(text).toContain('highlights[0]: clipId "rush-77" inconnu');
  });
});

describe('mergeTagging', () => {
  it('fusionne infos ffprobe et tagging, avec provenance', () => {
    const result = mergeTagging(clips, output, {
      model: 'gemini-test',
      taggedAt: '2026-09-20T10:00:00.000Z',
    });
    expect(taggingResultSchema.safeParse(result).success).toBe(true);
    expect(result.clips[0]).toMatchObject({
      id: 'rush-01',
      durationSec: 42,
      hasAudio: true,
      summary: output.clips[0]!.summary,
    });
    expect(result.clips[0]).not.toHaveProperty('clipId');
    expect(result.model).toBe('gemini-test');
  });

  it('refuse si un clip n’a pas été taggé', () => {
    expect(() =>
      mergeTagging(clips, { ...output, clips: [output.clips[0]!] }, { model: 'm' }),
    ).toThrow(/rush-02/);
  });
});
