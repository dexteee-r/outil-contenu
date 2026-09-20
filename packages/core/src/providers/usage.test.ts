import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../db/index.js';
import { apiCalls } from '../db/schema.js';
import { DEFAULT_PRICING, estimateCostUsd, loadPricing } from './pricing.js';
import { spendSince, startOfMonthIso, UsageTracker } from './usage.js';

describe('estimateCostUsd', () => {
  it('calcule un coût tokens et un coût image', () => {
    expect(
      estimateCostUsd(
        'claude-sonnet-5',
        { inputTokens: 1_000_000, outputTokens: 100_000 },
        DEFAULT_PRICING,
      ),
    ).toBe(3);
    expect(estimateCostUsd('gemini-3-pro-image', { images: 3 }, DEFAULT_PRICING)).toBeCloseTo(
      0.105,
    );
  });

  it('renvoie null (jamais 0) pour un modèle inconnu', () => {
    expect(estimateCostUsd('modele-mystere', { inputTokens: 10 }, DEFAULT_PRICING)).toBeNull();
  });
});

describe('loadPricing', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('fusionne pricing.json par-dessus la grille par défaut', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-pricing-'));
    fs.writeFileSync(
      path.join(dir, 'pricing.json'),
      JSON.stringify({
        'gemini-3.7-flash': { kind: 'tokens', inputPerMTok: 0.1, outputPerMTok: 0.4 },
      }),
    );
    const table = loadPricing(dir);
    expect(table['gemini-3.7-flash']).toEqual({
      kind: 'tokens',
      inputPerMTok: 0.1,
      outputPerMTok: 0.4,
    });
    expect(table['claude-sonnet-5']).toEqual(DEFAULT_PRICING['claude-sonnet-5']);
  });

  it('refuse un pricing.json mal formé', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-pricing-'));
    fs.writeFileSync(path.join(dir, 'pricing.json'), JSON.stringify({ x: { kind: 'tokens' } }));
    expect(() => loadPricing(dir)).toThrow(/pricing.json invalide/);
  });
});

describe('UsageTracker', () => {
  let db: Db;
  afterEach(() => closeDb(db));

  it('enregistre un appel réussi avec son coût en USD et EUR', async () => {
    db = openDb({ file: ':memory:' });
    const tracker = new UsageTracker(db, { pricing: DEFAULT_PRICING, usdEurRate: 0.5 });
    const out = await tracker.track(
      {
        module: 'edl',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        account: 'tcg',
        contentId: 'c1',
        jobId: 7,
      },
      () => Promise.resolve({ result: 'ok', usage: { inputTokens: 500_000, outputTokens: 0 } }),
    );
    expect(out).toBe('ok');
    const row = db.select().from(apiCalls).get();
    expect(row).toMatchObject({
      module: 'edl',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      account: 'tcg',
      contentId: 'c1',
      jobId: 7,
      inputTokens: 500_000,
      costUsd: 1,
      costEur: 0.5,
      status: 'ok',
      error: null,
    });
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enregistre aussi les échecs puis relance l’erreur', async () => {
    db = openDb({ file: ':memory:' });
    const tracker = new UsageTracker(db, { pricing: DEFAULT_PRICING, usdEurRate: 1 });
    await expect(
      tracker.track({ module: 'tagging', provider: 'gemini', model: 'x' }, () =>
        Promise.reject(new Error('429 quota')),
      ),
    ).rejects.toThrow('429 quota');
    const row = db.select().from(apiCalls).get();
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('429 quota');
    expect(row?.costUsd).toBeNull();
  });

  it('prévient une seule fois par modèle inconnu', async () => {
    db = openDb({ file: ':memory:' });
    const unknown: string[] = [];
    const tracker = new UsageTracker(db, {
      pricing: DEFAULT_PRICING,
      usdEurRate: 1,
      onUnknownModel: (m) => unknown.push(m),
    });
    const call = () => Promise.resolve({ result: 1, usage: { inputTokens: 1 } });
    await tracker.track({ module: 'tagging', provider: 'gemini', model: 'inconnu' }, call);
    await tracker.track({ module: 'tagging', provider: 'gemini', model: 'inconnu' }, call);
    expect(unknown).toEqual(['inconnu']);
  });

  it('spendSince additionne les coûts EUR du mois, filtrés par compte', async () => {
    db = openDb({ file: ':memory:' });
    const tracker = new UsageTracker(db, { pricing: DEFAULT_PRICING, usdEurRate: 1 });
    const one = () => Promise.resolve({ result: null, usage: { images: 1 } }); // 0.035 USD
    await tracker.track(
      { module: 'image', provider: 'gemini', model: 'gemini-3-pro-image', account: 'tcg' },
      one,
    );
    await tracker.track(
      { module: 'image', provider: 'gemini', model: 'gemini-3-pro-image', account: 'tcg' },
      one,
    );
    await tracker.track(
      { module: 'image', provider: 'gemini', model: 'gemini-3-pro-image', account: 'dexter' },
      one,
    );
    await tracker.track(
      { module: 'tagging', provider: 'gemini', model: 'inconnu', account: 'tcg' },
      one,
    );
    expect(spendSince(db, startOfMonthIso())).toBeCloseTo(0.105);
    expect(spendSince(db, startOfMonthIso(), { account: 'tcg' })).toBeCloseTo(0.07);
    expect(spendSince(db, new Date(Date.now() + 60_000).toISOString())).toBe(0);
  });
});
