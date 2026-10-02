import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../db/index.js';
import { apiCalls } from '../db/schema.js';
import { DEFAULT_PRICING, estimateCostUsd, loadPricing } from './pricing.js';
import {
  BudgetExceededError,
  spendSince,
  startOfMonthIso,
  UsageTracker,
  type Budget,
  type BudgetAlert,
} from './usage.js';

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

describe('garde-fou budgétaire', () => {
  let db: Db;
  afterEach(() => closeDb(db));

  // Une image à 0,035 $ = 0,035 € (taux 1) : 3 images franchissent un plafond de 0,10 €
  const image = (account: string, contentId?: string) => ({
    module: 'image' as const,
    provider: 'gemini' as const,
    model: 'gemini-3-pro-image',
    account,
    ...(contentId ? { contentId } : {}),
  });

  function setup(budgets: Record<string, Budget>) {
    db = openDb({ file: ':memory:' });
    const alerts: BudgetAlert[] = [];
    let calls = 0;
    const tracker = new UsageTracker(db, {
      pricing: DEFAULT_PRICING,
      usdEurRate: 1,
      budgetOf: (a) => budgets[a],
      onBudgetAlert: (a) => alerts.push(a),
    });
    const call = () => {
      calls++;
      return Promise.resolve({ result: null, usage: { images: 1 } });
    };
    return { tracker, alerts, call, calls: () => calls };
  }

  it('plafond strict : alerte au franchissement, puis refus avant tout appel', async () => {
    const { tracker, alerts, call, calls } = setup({ tcg: { mode: 'cap', monthlyLimitEur: 0.1 } });
    await tracker.track(image('tcg'), call);
    await tracker.track(image('tcg'), call);
    expect(alerts).toEqual([]);
    await tracker.track(image('tcg'), call); // 0,105 € : plafond franchi par cet appel
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ account: 'tcg', mode: 'cap', limitEur: 0.1 });
    expect(alerts[0]!.spentEur).toBeCloseTo(0.105);

    await expect(tracker.track(image('tcg'), call)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls()).toBe(3); // le fournisseur n'a pas été appelé
    expect(() => tracker.assertBudget('tcg')).toThrow(/plafond budgétaire du compte tcg atteint/);
    expect(tracker.budgetStatus('tcg')).toMatchObject({ capReached: true, limitEur: 0.1 });
  });

  it('un contenu admis (déjà en cours) va au bout malgré le plafond', async () => {
    const { tracker, call } = setup({ tcg: { mode: 'cap', monthlyLimitEur: 0.05 } });
    tracker.admit('c1');
    await tracker.track(image('tcg', 'c1'), call);
    await tracker.track(image('tcg', 'c1'), call); // au-delà du plafond, mais admis
    await expect(tracker.track(image('tcg', 'c2'), call)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    tracker.release('c1');
    await expect(tracker.track(image('tcg', 'c1'), call)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('seuil : alerte une fois sans bloquer ; plafond par compte, sans effet sur les autres', async () => {
    const { tracker, alerts, call } = setup({
      tcg: { mode: 'threshold', monthlyLimitEur: 0.05 },
      dexter: { mode: 'cap', monthlyLimitEur: 0.05 },
    });
    for (let i = 0; i < 4; i++) await tracker.track(image('tcg'), call);
    expect(alerts.map((a) => [a.account, a.mode])).toEqual([['tcg', 'threshold']]);
    expect(() => tracker.assertBudget('dexter')).not.toThrow();
    await tracker.track(image('sans-budget'), call); // illimité par défaut
  });
});
