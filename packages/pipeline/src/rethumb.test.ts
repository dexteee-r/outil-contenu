import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  contents,
  makeSyntheticClip,
  METADATA_FILENAME,
  openDb,
  type Db,
} from '@outil/core';
import { createPipelineContext } from './context.js';
import { regenerateThumbnails } from './rethumb.js';
import { loadState, saveState, type PipelineState } from './state.js';
import { buildMetadata } from './steps/deliver.js';
import { makeTestContext, writeTestAccount } from './test-helpers.js';

let dir: string;
let db: Db;
afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('regenerateThumbnails', () => {
  it('relit les rushs d’origine et remplace les miniatures d’un contenu livré', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-rethumb-'));
    writeTestAccount(dir, 'tcg');
    const ctx = makeTestContext(dir, { IMAGE_PROVIDER: 'gemini' }); // pas de kie → non détouré
    db = openDb({ file: ':memory:' });
    const p = createPipelineContext(ctx, db, () => {});

    // Rush d'origine dans /raw ; la copie de /processing a disparu à la livraison
    const rawDir = path.join(dir, 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    const clip = await makeSyntheticClip({
      out: path.join(rawDir, 'rush-01.mp4'),
      durationSec: 3,
      width: 540,
      height: 960,
      fps: 24,
    });
    const contentId = 'tcg-2026-08-05-abcd';
    db.insert(contents).values({ id: contentId, account: 'tcg', sourceDir: rawDir }).run();
    const readyDir = ctx.paths.ready('tcg', contentId);
    fs.mkdirSync(path.join(readyDir, 'work'), { recursive: true });
    const old = path.join(readyDir, 'thumb-9x16-v1.png');
    fs.writeFileSync(old, 'ancienne');

    const state: PipelineState = {
      version: 1,
      contentId,
      account: 'tcg',
      sourceDir: rawDir,
      workDir: path.join(readyDir, 'work'),
      createdAt: new Date().toISOString(),
      completedSteps: ['ingest', 'tag', 'edl', 'render', 'captions', 'thumbnail', 'qc', 'deliver'],
      sourceFiles: ['rush-01.mp4'],
      clips: [
        {
          id: 'rush-01',
          path: path.join(dir, 'processing', contentId, 'source', path.basename(clip)),
          durationSec: 3,
          width: 540,
          height: 960,
          hasAudio: true,
        },
      ],
      tagging: {
        clips: [
          {
            id: 'rush-01',
            path: clip,
            durationSec: 3,
            width: 540,
            height: 960,
            fps: 24,
            hasAudio: true,
            summary: 'x',
            scenes: [{ start: 0, end: 3, description: 'x', tags: [], audioEvents: [] }],
            transcript: [],
          },
        ],
        highlights: [
          { clipId: 'rush-01', start: 1, end: 2.5, score: 0.9, kind: 'climax', reason: 'x' },
        ],
        summary: 'x',
        model: 'test',
        taggedAt: '2026-09-21T10:00:00.000Z',
      },
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
      thumbnailHit: { clipId: 'rush-01', atSec: 2.4, what: 'carte' },
      thumbnails: [{ path: old, format: '9x16', variant: 1, selected: true, background: 'frame' }],
      deliveredDir: readyDir,
    };
    saveState(state);
    const metadata = buildMetadata(state, {
      video: 'video.mp4',
      thumbnails: [{ path: 'thumb-9x16-v1.png', format: '9x16', variant: 1, selected: true }],
    });
    fs.writeFileSync(path.join(readyDir, METADATA_FILENAME), JSON.stringify(metadata));

    await regenerateThumbnails(p, contentId);

    const names = fs.readdirSync(readyDir).filter((n) => n.startsWith('thumb-'));
    expect(names.sort()).toEqual([
      'thumb-16x9-v1.png',
      'thumb-16x9-v2.png',
      'thumb-9x16-v1.png',
      'thumb-9x16-v2.png',
    ]);
    expect(fs.readFileSync(old).length).toBeGreaterThan(1000); // remplacée par une vraie image
    const meta = JSON.parse(fs.readFileSync(path.join(readyDir, METADATA_FILENAME), 'utf8')) as {
      thumbnails: { path: string; selected: boolean }[];
      captions: unknown;
    };
    expect(meta.thumbnails).toHaveLength(4);
    expect(meta.thumbnails.filter((t) => t.selected)).toHaveLength(2);
    expect(meta.captions).toEqual(metadata.captions); // le reste est conservé
    const saved = loadState(path.join(readyDir, 'work'));
    expect(saved.clips![0]!.path).toBe(clip); // pointe désormais vers le rush d'origine
  }, 60_000);

  it('refuse un contenu inconnu', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-rethumb-'));
    db = openDb({ file: ':memory:' });
    const p = createPipelineContext(makeTestContext(dir), db, () => {});
    await expect(regenerateThumbnails(p, 'nope')).rejects.toThrow(/inconnu/);
  });
});
