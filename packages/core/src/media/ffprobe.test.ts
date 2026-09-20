import { describe, expect, it } from 'vitest';
import { clipIdFromFile, parseProbe } from './ffprobe.js';

const sample = {
  streams: [
    {
      codec_type: 'video',
      width: 1080,
      height: 1920,
      r_frame_rate: '30000/1001',
      duration: '42.0',
    },
    { codec_type: 'audio', duration: '42.0' },
  ],
  format: { duration: '42.042000' },
};

describe('parseProbe', () => {
  it('extrait durée, dimensions, fps et présence audio', () => {
    expect(parseProbe(sample)).toEqual({
      durationSec: 42.042,
      width: 1080,
      height: 1920,
      fps: 29.97,
      hasAudio: true,
    });
  });

  it('détecte l’absence de piste audio et de piste vidéo', () => {
    expect(parseProbe({ ...sample, streams: [sample.streams[0]] }).hasAudio).toBe(false);
    expect(() => parseProbe({ ...sample, streams: [sample.streams[1]] })).toThrow(
      /aucune piste vidéo/,
    );
  });

  it('refuse une durée illisible', () => {
    expect(() =>
      parseProbe({ streams: [{ codec_type: 'video', width: 1, height: 1 }], format: {} }),
    ).toThrow(/durée illisible/);
  });
});

describe('clipIdFromFile', () => {
  it('normalise le nom de fichier', () => {
    expect(clipIdFromFile('C:\\rushs\\IMG_0042.MOV', 0)).toBe('img-0042');
    expect(clipIdFromFile('/tmp/Ouverture booster (1).mp4', 0)).toBe('ouverture-booster-1');
    expect(clipIdFromFile('/tmp/___.mp4', 4)).toBe('clip-5');
  });
});
