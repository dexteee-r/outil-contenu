import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTaggingPrompt,
  closeDb,
  contents,
  loadAccount,
  makeSyntheticClip,
  openDb,
  type Db,
} from '@outil/core';
import { createPipelineContext } from './context.js';
import type { StepFn } from './runner.js';
import { buildCaptionsSystem } from './steps/captions.js';
import { makeTestContext, writeTestAccount } from './test-helpers.js';
import { PROCESSED_MARKER, runWatcher } from './watch.js';

/**
 * Plusieurs comptes (étape 8) : chaque compte reçoit ses propres consignes (type de contenu,
 * instructions du compte) et ses contenus restent dans ses dossiers, même traités le même jour.
 */

let dir: string;
let db: Db;
afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-comptes-'));
  writeTestAccount(dir, 'tcg');
  writeTestAccount(dir, 'dexter-labo', { contentType: 'tech-repair' });
  fs.writeFileSync(
    path.join(dir, 'accounts', 'dexter-labo', 'prompts', 'captions.md'),
    'Ton : passionné, tutoiement.',
  );
  db = openDb({ file: ':memory:' });
  const logs: string[] = [];
  const p = createPipelineContext(makeTestContext(dir), db, (m) => logs.push(m));
  return { p, logs };
}

describe('consignes par compte', () => {
  it('légendes : chaque type de contenu a ses consignes de miniature, sans celles des autres', () => {
    const { p } = setup();
    const tech = buildCaptionsSystem(p, loadAccount('dexter-labo', p.ctx.accountsDir));
    expect(tech).toContain('Spécifique : réparation et montage');
    expect(tech).toContain('## Instructions du compte DEXTER-LABO\n\nTon : passionné, tutoiement.');
    expect(tech).not.toMatch(/booster|carte hit|TCG/i);

    const tcg = buildCaptionsSystem(p, loadAccount('tcg', p.ctx.accountsDir));
    expect(tcg).toContain('Spécifique : ouverture de cartes');
    expect(tcg).toContain('Ton : enthousiaste.');
    expect(tcg).not.toContain('réparation');
  });

  it('dérushage : consignes du type de contenu', () => {
    const { p } = setup();
    const prompt = buildTaggingPrompt({
      contentType: 'tech-repair',
      clips: [],
      dir: p.ctx.promptsDir,
    });
    expect(prompt).toContain('premier démarrage');
    expect(prompt).not.toMatch(/booster/i);
  });
});

describe('deux comptes le même jour', () => {
  it('chaque dossier est traité avec son compte, sans mélange', async () => {
    const { p } = setup();
    const seen: string[] = [];
    const deliver: StepFn = (_p, s, account) => {
      seen.push(`${s.account}:${account.config.slug}:${account.config.contentType}`);
      p.db.update(contents).set({ status: 'ready' }).where(eq(contents.id, s.contentId)).run();
      return Promise.resolve();
    };
    const noop: StepFn = () => Promise.resolve();
    const run = {
      tag: noop,
      edl: noop,
      render: noop,
      captions: noop,
      thumbnail: noop,
      qc: noop,
      deliver,
      notify: noop,
    };

    const folders: Record<string, string> = {};
    for (const slug of ['tcg', 'dexter-labo']) {
      const d = path.join(p.ctx.paths.raw(slug), '2026-10-03');
      fs.mkdirSync(d, { recursive: true });
      await makeSyntheticClip({
        out: path.join(d, 'rush.mp4'),
        durationSec: 1,
        width: 64,
        height: 128,
        fps: 12,
      });
      folders[slug] = d;
    }

    expect(await runWatcher(p, { quietMs: 0, intervalMs: 10, once: true, run })).toBe(2);
    expect(seen.sort()).toEqual(['dexter-labo:dexter-labo:tech-repair', 'tcg:tcg:tcg-opening']);
    const rows = db.select().from(contents).all();
    for (const slug of ['tcg', 'dexter-labo']) {
      const row = rows.find((r) => r.account === slug)!;
      expect(row.id.startsWith(`${slug}-`)).toBe(true);
      expect(row.sourceDir).toBe(path.resolve(folders[slug]!));
      expect(fs.existsSync(path.join(folders[slug]!, PROCESSED_MARKER))).toBe(true);
    }
  }, 60_000);
});
