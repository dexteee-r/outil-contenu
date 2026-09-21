import { describe, expect, it } from 'vitest';
import { backoffDelayMs, isTransientApiError, retry } from './retry.js';

/** Erreur imitant celles du SDK Google (statut HTTP porté par l'erreur). */
const apiError = (status: number, message = 'erreur api') =>
  Object.assign(new Error(message), { status });

describe('isTransientApiError', () => {
  it('reconnaît les statuts passagers et les messages Google', () => {
    expect(isTransientApiError({ status: 503, message: 'x' })).toBe(true);
    expect(isTransientApiError({ status: 429 })).toBe(true);
    expect(isTransientApiError({ code: 500 })).toBe(true);
    expect(isTransientApiError(new Error('{"error":{"status":"UNAVAILABLE"}}'))).toBe(true);
    expect(isTransientApiError(new Error('fetch failed'))).toBe(true);
  });

  it('ne rejoue pas les erreurs de contrat', () => {
    expect(isTransientApiError({ status: 400, message: 'invalid argument' })).toBe(false);
    expect(isTransientApiError({ status: 404 })).toBe(false);
    expect(isTransientApiError(new Error('réponse hors schéma'))).toBe(false);
    expect(isTransientApiError(null)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('double à chaque tentative, plafonné, avec ±20 % d’aléa', () => {
    for (let i = 0; i < 20; i++) {
      expect(backoffDelayMs(1, 1000, 30_000)).toBeGreaterThanOrEqual(800);
      expect(backoffDelayMs(1, 1000, 30_000)).toBeLessThanOrEqual(1200);
      expect(backoffDelayMs(3, 1000, 30_000)).toBeGreaterThanOrEqual(3200);
      expect(backoffDelayMs(3, 1000, 30_000)).toBeLessThanOrEqual(4800);
      expect(backoffDelayMs(10, 1000, 30_000)).toBeLessThanOrEqual(36_000);
    }
  });
});

describe('retry', () => {
  const noSleep = () => Promise.resolve();

  it('rejoue une erreur passagère puis réussit', async () => {
    let calls = 0;
    const retries: number[] = [];
    const out = await retry(
      () => {
        calls++;
        return calls < 3 ? Promise.reject(apiError(503)) : Promise.resolve('ok');
      },
      { sleep: noSleep, onRetry: (i) => retries.push(i.attempt) },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it('abandonne après le nombre de tentatives', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls++;
          return Promise.reject(apiError(429, 'quota'));
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(3);
  });

  it('ne rejoue pas une erreur non passagère', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls++;
          return Promise.reject(new Error('400 bad request'));
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('400');
    expect(calls).toBe(1);
  });
});
