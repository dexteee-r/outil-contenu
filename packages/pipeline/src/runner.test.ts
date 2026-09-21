import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, contents, jobs, jobSteps, loadAccount, openDb, type Db } from '@outil/core';
import { createPipelineContext, type PipelineContext } from './context.js';
import { loadState, saveState, type PipelineState } from './state.js';
import { resumeContent, runSteps, type StepFn } from './runner.js';
import { makeTestContext, writeTestAccount } from './test-helpers.js';

let dir: string;
let db: Db;
let p: PipelineContext;
let webhookCalls: { url: string; body: string }[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-runner-'));
  writeTestAccount(dir, 'tcg');
  webhookCalls = [];
  const ctx = makeTestContext(dir, {
    N8N_WEBHOOK_FAILED_URL: 'https://n8n.test/failed',
    N8N_WEBHOOK_READY_URL: 'https://n8n.test/ready',
  });
  db = openDb({ file: ':memory:' });
  p = createPipelineContext(ctx, db, () => {});
});

afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function baseState(): PipelineState {
  const state: PipelineState = {
    version: 1,
    contentId: 'tcg-2026-08-05-abcd',
    account: 'tcg',
    sourceDir: path.join(dir, 'raw'),
    workDir: p.ctx.paths.processing('tcg-2026-08-05-abcd'),
    createdAt: new Date().toISOString(),
    completedSteps: ['ingest'],
    sourceFiles: ['a.mov'],
  };
  saveState(state);
  db.insert(contents)
    .values({
      id: state.contentId,
      account: 'tcg',
      sourceDir: state.sourceDir,
      status: 'processing',
    })
    .run();
  return state;
}

const ok =
  (name: string, calls: string[]): StepFn =>
  () => {
    calls.push(name);
    return Promise.resolve();
  };

describe('runSteps', () => {
  it('exécute les étapes dans l’ordre, journalise job_steps et persiste l’état', async () => {
    const state = baseState();
    const job = db
      .insert(jobs)
      .values({ contentId: state.contentId, status: 'running' })
      .returning()
      .get();
    const calls: string[] = [];
    const steps = Object.fromEntries(
      ['tag', 'edl', 'render', 'captions', 'thumbnail', 'qc', 'deliver'].map((s) => [
        s,
        ok(s, calls),
      ]),
    );
    await runSteps(p, state, loadAccount('tcg', p.ctx.accountsDir), job.id, {
      steps: { ...steps, notify: ok('notify', calls) },
    });
    expect(calls).toEqual([
      'tag',
      'edl',
      'render',
      'captions',
      'thumbnail',
      'qc',
      'deliver',
      'notify',
    ]);
    expect(loadState(state.workDir).completedSteps).toEqual(['ingest', ...calls]);
    const rows = db.select().from(jobSteps).all();
    expect(rows.map((r) => `${r.step}:${r.status}`)).toEqual(calls.map((c) => `${c}:done`));
    expect(db.select().from(jobs).get()).toMatchObject({ status: 'done', currentStep: null });
  });

  it('sur échec : job et contenu en failed, alerte d’échec envoyée, erreur remontée', async () => {
    const state = baseState();
    const job = db
      .insert(jobs)
      .values({ contentId: state.contentId, status: 'running' })
      .returning()
      .get();
    const calls: string[] = [];
    const failing: StepFn = () => Promise.reject(new Error('EDL toujours invalide'));
    // on intercepte fetch pour capter le webhook d'échec
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: { body: string }) => {
      webhookCalls.push({ url, body: init.body });
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        runSteps(p, state, loadAccount('tcg', p.ctx.accountsDir), job.id, {
          steps: { tag: ok('tag', calls), edl: failing, render: ok('render', calls) },
        }),
      ).rejects.toThrow('EDL toujours invalide');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(['tag']);
    expect(db.select().from(jobs).get()).toMatchObject({
      status: 'failed',
      currentStep: 'edl',
      error: 'EDL toujours invalide',
    });
    expect(db.select().from(contents).get()?.status).toBe('failed');
    expect(
      db
        .select()
        .from(jobSteps)
        .all()
        .map((r) => `${r.step}:${r.status}`),
    ).toEqual(['tag:done', 'edl:failed']);
    expect(loadState(state.workDir).completedSteps).toEqual(['ingest', 'tag']);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.url).toBe('https://n8n.test/failed');
    expect(JSON.parse(webhookCalls[0]!.body)).toMatchObject({
      event: 'failed',
      step: 'edl',
      contentId: state.contentId,
    });
  });
});

describe('resumeContent', () => {
  it('reprend à la première étape manquante avec un nouveau job', async () => {
    const state = baseState();
    state.completedSteps = ['ingest', 'tag', 'edl'];
    saveState(state);
    db.insert(jobs)
      .values({ contentId: state.contentId, status: 'failed', attempt: 1, currentStep: 'render' })
      .run();
    const calls: string[] = [];
    const steps = Object.fromEntries(
      ['tag', 'edl', 'render', 'captions', 'thumbnail', 'qc', 'deliver', 'notify'].map((s) => [
        s,
        ok(s, calls),
      ]),
    );
    await resumeContent(p, state.contentId, { steps });
    expect(calls).toEqual(['render', 'captions', 'thumbnail', 'qc', 'deliver', 'notify']);
    const all = db.select().from(jobs).all();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ attempt: 2, status: 'done' });
  });

  it('refuse un contenu inconnu', async () => {
    await expect(resumeContent(p, 'inconnu')).rejects.toThrow(/introuvable/);
  });
});
