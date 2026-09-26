import { describe, expect, it } from 'vitest';
import { withModelFallback } from './tag.js';

const daily = Object.assign(
  new Error('You exceeded your current quota … GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
  { status: 429 },
);
const overloaded = Object.assign(new Error('This model is currently experiencing high demand'), {
  status: 503,
});

describe('withModelFallback', () => {
  it('bascule sur le modèle suivant quand le quota du jour est épuisé ou le modèle surchargé', async () => {
    const tried: string[] = [];
    const logs: string[] = [];
    const result = await withModelFallback(
      ['a', 'b', 'c'],
      (m) => {
        tried.push(m);
        if (m === 'a') return Promise.reject(daily);
        if (m === 'b') return Promise.reject(overloaded);
        return Promise.resolve(`ok ${m}`);
      },
      (l) => logs.push(l),
    );
    expect(result).toBe('ok c');
    expect(tried).toEqual(['a', 'b', 'c']);
    expect(logs).toEqual([
      'tag : a a épuisé son quota du jour — bascule sur b',
      'tag : b reste indisponible — bascule sur c',
    ]);
  });

  it('ne bascule pas sur une erreur de contrat ; remonte la dernière erreur si tout est épuisé', async () => {
    const bad = Object.assign(new Error('invalid argument'), { status: 400 });
    await expect(
      withModelFallback(
        ['a', 'b'],
        () => Promise.reject(bad),
        () => {},
      ),
    ).rejects.toBe(bad);
    await expect(
      withModelFallback(
        ['a', 'b'],
        () => Promise.reject(daily),
        () => {},
      ),
    ).rejects.toBe(daily);
  });
});
