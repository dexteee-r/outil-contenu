import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMusicIndex, musicIndexSchema, selectTrack, type MusicIndex } from './index.js';
import { hitSfxPath, loadSfxIndex, sfxIndexSchema, sfxPathFor } from './sfx.js';

const index: MusicIndex = {
  tracks: [
    { file: 'a.mp3', title: 'A', moods: ['hype'], bpm: 128, durationSec: 90, license: 'CC0' },
    {
      file: 'b.mp3',
      title: 'B',
      moods: ['hype', 'tension'],
      bpm: 100,
      durationSec: 60,
      license: 'CC0',
    },
    { file: 'c.mp3', title: 'C', moods: ['calm'], bpm: 70, durationSec: 120, license: 'CC0' },
    { file: 'd.mp3', title: 'D', moods: ['hype'], bpm: 135, durationSec: 20, license: 'CC0' },
  ],
};

describe('selectTrack', () => {
  it('choisit le mood demandé avec le tempo dans la plage', () => {
    expect(
      selectTrack(index, { mood: 'hype', tempoRange: { min: 120, max: 140 }, minDurationSec: 30 })
        ?.file,
    ).toBe('a.mp3');
  });

  it('accepte un tempo hors plage au plus proche si rien ne colle', () => {
    expect(
      selectTrack(index, { mood: 'hype', tempoRange: { min: 90, max: 95 }, minDurationSec: 30 })
        ?.file,
    ).toBe('b.mp3');
  });

  it('exclut les pistes trop courtes et les moods absents', () => {
    expect(
      selectTrack(index, { mood: 'hype', tempoRange: { min: 130, max: 140 }, minDurationSec: 30 })
        ?.file,
    ).toBe('a.mp3');
    expect(
      selectTrack(index, {
        mood: 'reveal',
        tempoRange: { min: 100, max: 120 },
        minDurationSec: 10,
      }),
    ).toBeNull();
    expect(
      selectTrack(
        { tracks: [] },
        { mood: 'hype', tempoRange: { min: 100, max: 120 }, minDurationSec: 10 },
      ),
    ).toBeNull();
  });

  it('préfère une piste libre à une piste protégée, qui reste un dernier recours', () => {
    const op = {
      file: 'op.mp3',
      title: 'OST',
      moods: ['reveal'],
      bpm: 138,
      durationSec: 280,
      license: 'Protégée',
      restricted: true,
    };
    const free = {
      file: 'free.mp3',
      title: 'F',
      moods: ['reveal'],
      bpm: 150,
      durationSec: 120,
      license: 'Pixabay',
    };
    const req = { mood: 'reveal', tempoRange: { min: 130, max: 140 }, minDurationSec: 20 };
    expect(selectTrack({ tracks: [op, free] }, req)?.file).toBe('free.mp3'); // malgré le tempo
    expect(selectTrack({ tracks: [op] }, req)?.file).toBe('op.mp3');
  });

  it('ignore la casse du mood', () => {
    expect(
      selectTrack(index, { mood: 'CALM', tempoRange: { min: 60, max: 80 }, minDurationSec: 10 })
        ?.file,
    ).toBe('c.mp3');
  });
});

describe('loadMusicIndex', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('renvoie une bibliothèque vide sans fichier, sinon valide le JSON', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-music-'));
    expect(loadMusicIndex(dir)).toEqual({ tracks: [] });
    fs.writeFileSync(path.join(dir, 'music.json'), JSON.stringify(index));
    expect(loadMusicIndex(dir).tracks).toHaveLength(4);
    fs.writeFileSync(path.join(dir, 'music.json'), JSON.stringify({ tracks: [{ file: 'x' }] }));
    expect(() => loadMusicIndex(dir)).toThrow();
  });

  it('refuse une piste sans licence', () => {
    expect(
      musicIndexSchema.safeParse({ tracks: [{ ...index.tracks[0], license: undefined }] }).success,
    ).toBe(false);
  });
});

describe('sfx', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('renvoie null sans index ou sans fichier, le chemin sinon', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-sfx-'));
    expect(loadSfxIndex(dir)).toEqual({});
    expect(hitSfxPath(dir)).toBeNull();
    fs.writeFileSync(
      path.join(dir, 'sfx.json'),
      JSON.stringify({ hit: { file: 'h.mp3', license: 'CC0' } }),
    );
    expect(hitSfxPath(dir)).toBeNull(); // déclaré mais absent
    fs.writeFileSync(path.join(dir, 'h.mp3'), 'x');
    expect(hitSfxPath(dir)).toBe(path.join(dir, 'h.mp3'));
  });

  it('résout les quatre types de sons ; refuse un type inconnu', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-sfx-'));
    fs.mkdirSync(path.join(dir, 'riser'));
    fs.writeFileSync(path.join(dir, 'riser', 'r.mp3'), 'x');
    fs.writeFileSync(
      path.join(dir, 'sfx.json'),
      JSON.stringify({ riser: { file: 'riser/r.mp3', license: 'CC0' } }),
    );
    expect(sfxPathFor(dir, 'riser')).toBe(path.join(dir, 'riser', 'r.mp3'));
    expect(sfxPathFor(dir, 'whoosh')).toBeNull();
    expect(sfxIndexSchema.safeParse({ boom: { file: 'b.mp3', license: 'x' } }).success).toBe(false);
  });
});
