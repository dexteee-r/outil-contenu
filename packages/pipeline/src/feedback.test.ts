import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  contents,
  feedback,
  jobs,
  loadReferenceEdl,
  METADATA_FILENAME,
  openDb,
  type Db,
} from '@outil/core';
import { createPipelineContext, type PipelineContext } from './context.js';
import { startFeedback } from './feedback.js';
import type { StepFn } from './runner.js';
import { currentFeedback, saveState, type PipelineState } from './state.js';
import { thumbnailFeedbackRequest } from './steps/captions.js';
import { buildMetadata, deliver } from './steps/deliver.js';
import { edlFeedbackRequest } from './steps/edl.js';
import { makeTestContext, writeTestAccount } from './test-helpers.js';

let dir: string;
let db: Db;
afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const contentId = 'tcg-2026-08-05-abcd';

/** Contenu livré en version 1 : vidéo, deux miniatures, metadata.json, état, ligne en base. */
function deliveredContent(): { p: PipelineContext; readyDir: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-feedback-'));
  writeTestAccount(dir, 'tcg');
  const ctx = makeTestContext(dir);
  db = openDb({ file: ':memory:' });
  const p = createPipelineContext(ctx, db, () => {});
  const rawDir = path.join(dir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'rush-01.mp4'), 'rush');
  db.insert(contents)
    .values({ id: contentId, account: 'tcg', sourceDir: rawDir, status: 'ready' })
    .run();

  const readyDir = ctx.paths.ready('tcg', contentId);
  fs.mkdirSync(path.join(readyDir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(readyDir, 'video.mp4'), 'video v1');
  for (const f of ['9x16', '16x9']) fs.writeFileSync(path.join(readyDir, `thumb-${f}-v1.png`), f);
  const state: PipelineState = {
    version: 1,
    contentId,
    account: 'tcg',
    sourceDir: rawDir,
    workDir: path.join(readyDir, 'work'),
    createdAt: new Date().toISOString(),
    completedSteps: [
      'ingest',
      'tag',
      'edl',
      'render',
      'captions',
      'thumbnail',
      'qc',
      'deliver',
      'notify',
    ],
    sourceFiles: ['rush-01.mp4'],
    clips: [
      {
        id: 'rush-01',
        path: path.join(dir, 'processing', contentId, 'source', 'rush-01.mp4'),
        durationSec: 3,
        width: 540,
        height: 960,
        hasAudio: true,
      },
    ],
    edl: loadReferenceEdl(),
    render: {
      path: path.join(readyDir, 'video.mp4'),
      durationSec: 20,
      width: 1080,
      height: 1920,
      renderMs: 1,
    },
    captions: { tiktok: { title: 'Titre', description: 'Desc', hashtags: ['#tcg'] } },
    thumbnailTitle: 'QUEL HIT ?',
    thumbnailSubject: { clipId: 'rush-01', atSec: 0.5, what: 'booster' },
    thumbnailHit: null,
    thumbnails: ['9x16', '16x9'].map((f) => ({
      path: path.join(readyDir, `thumb-${f}-v1.png`),
      format: f as '9x16' | '16x9',
      variant: 1,
      selected: true,
      background: 'frame' as const,
    })),
    deliveredDir: readyDir,
  };
  saveState(state);
  const metadata = buildMetadata(state, {
    video: 'video.mp4',
    thumbnails: state.thumbnails!.map((t) => ({
      path: path.basename(t.path),
      format: t.format,
      variant: 1,
      selected: true,
    })),
  });
  fs.writeFileSync(path.join(readyDir, METADATA_FILENAME), JSON.stringify(metadata));
  return { p, readyDir };
}

const forbidden =
  (name: string): StepFn =>
  () =>
    Promise.reject(new Error(`${name} ne devait pas être refait`));
const noop: StepFn = () => Promise.resolve();
const realDeliver: StepFn = (p, state) => {
  deliver(p, state);
  return Promise.resolve();
};

describe('startFeedback', () => {
  it('retour vidéo : nouvel EDL + rendu, v1 rangée dans v1/, livré en version 2', async () => {
    const { p, readyDir } = deliveredContent();
    const seen: string[] = [];
    const state = await startFeedback(
      p,
      contentId,
      { target: 'video', text: '  coupe plus tôt  ' },
      {
        steps: {
          tag: forbidden('tag'),
          captions: forbidden('captions'),
          thumbnail: forbidden('thumbnail'),
          edl: (_p, s) => {
            seen.push(currentFeedback(s, 'video')?.text ?? '(aucun)');
            expect(s.clips![0]!.path).toBe(path.join(dir, 'raw', 'rush-01.mp4'));
            return Promise.resolve();
          },
          render: (_p, s) => {
            const out = path.join(s.workDir, 'video.mp4');
            fs.writeFileSync(out, 'video v2');
            s.render = { ...s.render!, path: out };
            return Promise.resolve();
          },
          qc: noop,
          deliver: realDeliver,
          notify: noop,
        },
      },
    );

    expect(seen).toEqual(['coupe plus tôt']);
    expect(state.revision).toBe(2);
    expect(fs.readFileSync(path.join(readyDir, 'video.mp4'), 'utf8')).toBe('video v2');
    expect(fs.readFileSync(path.join(readyDir, 'v1', 'video.mp4'), 'utf8')).toBe('video v1');
    expect(fs.existsSync(path.join(readyDir, 'v1', METADATA_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(readyDir, 'v1', 'thumb-9x16-v1.png'))).toBe(true);
    expect(fs.readFileSync(path.join(readyDir, 'thumb-9x16-v1.png'), 'utf8')).toBe('9x16'); // reprise
    const meta = JSON.parse(fs.readFileSync(path.join(readyDir, METADATA_FILENAME), 'utf8')) as {
      version: number;
    };
    expect(meta.version).toBe(2);
    const row = db.select().from(contents).get()!;
    expect([row.status, row.version]).toEqual(['ready', 2]);
    const job = db.select().from(jobs).get()!;
    expect([job.kind, job.status]).toEqual(['feedback', 'done']);
    const fb = db.select().from(feedback).get()!;
    expect([fb.target, fb.text, fb.resultingJobId]).toEqual(['video', 'coupe plus tôt', job.id]);
    expect(fs.existsSync(p.ctx.paths.processing(contentId))).toBe(false);
  });

  it('retour miniature : seules légendes et miniature sont refaites, la vidéo est reprise', async () => {
    const { p, readyDir } = deliveredContent();
    const called: string[] = [];
    await startFeedback(
      p,
      contentId,
      { target: 'thumbnail', text: 'mets la carte en avant' },
      {
        steps: {
          edl: forbidden('edl'),
          render: forbidden('render'),
          captions: (_p, s) => {
            called.push(`captions:${currentFeedback(s, 'thumbnail')?.text ?? ''}`);
            return Promise.resolve();
          },
          thumbnail: (_p, s) => {
            called.push('thumbnail');
            const out = path.join(s.workDir, 'thumb-16x9-v1.png');
            fs.writeFileSync(out, 'nouvelle');
            s.thumbnails = [
              { path: out, format: '16x9', variant: 1, selected: true, background: 'frame' },
            ];
            return Promise.resolve();
          },
          qc: noop,
          deliver: realDeliver,
          notify: noop,
        },
      },
    );
    expect(called).toEqual(['captions:mets la carte en avant', 'thumbnail']);
    expect(fs.readFileSync(path.join(readyDir, 'video.mp4'), 'utf8')).toBe('video v1');
    expect(fs.readFileSync(path.join(readyDir, 'thumb-16x9-v1.png'), 'utf8')).toBe('nouvelle');
    expect(fs.existsSync(path.join(readyDir, 'thumb-9x16-v1.png'))).toBe(false); // rangée dans v1/
  });

  it('refuse un contenu non livré ou un retour vide', async () => {
    const { p } = deliveredContent();
    await expect(startFeedback(p, contentId, { target: 'video', text: '  ' })).rejects.toThrow(
      /vide/,
    );
    db.update(contents).set({ status: 'failed' }).run();
    await expect(startFeedback(p, contentId, { target: 'video', text: 'x' })).rejects.toThrow(
      /pas livré/,
    );
    await expect(startFeedback(p, 'nope', { target: 'video', text: 'x' })).rejects.toThrow(
      /inconnu/,
    );
  });
});

describe('messages de relance', () => {
  it('citent le retour et demandent de garder le reste', () => {
    expect(edlFeedbackRequest('coupe plus tôt')).toContain('« coupe plus tôt »');
    expect(edlFeedbackRequest('x')).toMatch(/Garde tout ce que le retour ne remet pas en cause/);
    expect(thumbnailFeedbackRequest('carte plus grande')).toMatch(/thumbnailHit/);
  });

  it('currentFeedback ne vaut que pour la version en cours et la bonne cible', () => {
    const base = { revision: 2 } as PipelineState;
    const fb = { target: 'video' as const, text: 'x', at: new Date().toISOString(), revision: 2 };
    expect(currentFeedback({ ...base, feedback: [fb] }, 'video')?.text).toBe('x');
    expect(currentFeedback({ ...base, feedback: [fb] }, 'thumbnail')).toBeUndefined();
    expect(currentFeedback({ ...base, revision: 3, feedback: [fb] }, 'video')).toBeUndefined();
  });
});
