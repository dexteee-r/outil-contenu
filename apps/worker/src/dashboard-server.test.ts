import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiCalls,
  closeDb,
  contents,
  envSchema,
  openDb,
  type AppContext,
  type Db,
} from '@outil/core';
import {
  createPipelineContext,
  JobQueue,
  saveState,
  WatchControl,
  type PipelineState,
} from '@outil/pipeline';
import { safeSegment, startDashboard } from './dashboard-server.js';

let dir: string;
let db: Db;
let server: http.Server;
let base: string;
let queue: JobQueue;
let control: WatchControl;
const logs: string[] = [];

function testContext(root: string): AppContext {
  const env = envSchema.parse({
    DATA_ROOT: path.join(root, 'data'),
    ACCOUNTS_DIR: path.join(root, 'accounts'),
    MODEL_TAGGING: 'gemini-test',
  });
  const data = env.DATA_ROOT;
  const join = (...parts: (string | undefined)[]) =>
    path.join(data, ...parts.filter((x): x is string => x !== undefined));
  return {
    repoRoot: root,
    env,
    paths: {
      root: data,
      db: ':memory:',
      raw: (account, date) => join('raw', account, date),
      processing: (id) => join('processing', id),
      ready: (account, id) => join('ready', account, id),
    },
    accountsDir: path.join(root, 'accounts'),
    promptsDir: path.join(root, 'prompts'),
    pricing: {},
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-dash-'));
  fs.mkdirSync(path.join(dir, 'accounts', 'tcg'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'accounts', 'tcg', 'account.yaml'),
    [
      'slug: tcg',
      'displayName: TCG',
      'contentType: tcg-opening',
      'platforms: [tiktok]',
      'brand:',
      '  colors: { primary: "#FFCC00", secondary: "#1A1A2E", background: "#0F0F1A", text: "#FFFFFF" }',
      'musicMoods: [hype]',
      'durationRange: { min: 15, max: 60 }',
      'budget: { mode: threshold, monthlyLimitEur: 5 }',
    ].join('\n'),
  );
  const ctx = testContext(dir);
  db = openDb({ file: ':memory:' });
  const p = createPipelineContext(ctx, db, (m) => logs.push(m));

  // Un contenu livré : vidéo de 1000 octets, deux miniatures, état, coût
  const readyDir = ctx.paths.ready('tcg', 'tcg-2026-08-05-abcd');
  fs.mkdirSync(path.join(readyDir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(readyDir, 'video.mp4'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(readyDir, 'thumb-16x9-v1.png'), 'png');
  fs.writeFileSync(path.join(readyDir, 'account.yaml'), 'secret');
  const rawDir = ctx.paths.raw('tcg', '2026-08-05');
  fs.mkdirSync(rawDir, { recursive: true });
  db.insert(contents)
    .values({ id: 'tcg-2026-08-05-abcd', account: 'tcg', sourceDir: rawDir, status: 'ready' })
    .run();
  db.insert(apiCalls)
    .values({
      module: 'edl',
      provider: 'anthropic',
      model: 'claude',
      account: 'tcg',
      contentId: 'tcg-2026-08-05-abcd',
      costUsd: 0.04,
      durationMs: 10,
      status: 'ok',
    })
    .run();
  const state: PipelineState = {
    version: 1,
    contentId: 'tcg-2026-08-05-abcd',
    account: 'tcg',
    sourceDir: rawDir,
    workDir: path.join(readyDir, 'work'),
    createdAt: new Date().toISOString(),
    completedSteps: ['ingest', 'tag', 'edl', 'render', 'captions', 'thumbnail', 'qc', 'deliver'],
    sourceFiles: ['a.mp4'],
    captions: { tiktok: { title: 'Titre TikTok', description: 'Desc', hashtags: ['tcg'] } },
    thumbnailTitle: 'QUEL HIT ?',
    thumbnails: [
      {
        path: path.join(readyDir, 'thumb-16x9-v1.png'),
        format: '16x9',
        variant: 1,
        selected: true,
        background: 'frame',
      },
    ],
    render: {
      path: path.join(readyDir, 'video.mp4'),
      durationSec: 26,
      width: 1080,
      height: 1920,
      renderMs: 1,
    },
    deliveredDir: readyDir,
  };
  saveState(state);

  queue = new JobQueue();
  control = new WatchControl();
  const started = await startDashboard({ p, queue, control, logs: () => logs, port: 0 });
  server = started.server;
  base = started.url;
});

afterEach(async () => {
  await queue.idle();
  await new Promise((r) => server.close(r));
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('tableau de bord', () => {
  it('sert la page, l’état du worker, la liste et le détail des contenus', async () => {
    const page = await fetch(`${base}/`);
    expect(await page.text()).toContain('Outil contenu');

    const status = await json(await fetch(`${base}/api/status`));
    expect(status.watching).toBe(true);

    const list = (await json(await fetch(`${base}/api/contents`))).contents as Record<
      string,
      unknown
    >[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'tcg-2026-08-05-abcd',
      status: 'ready',
      title: 'Titre TikTok',
      thumbnailTitle: 'QUEL HIT ?',
      durationSec: 26,
      preview: 'thumb-16x9-v1.png',
      costUsd: 0.04,
    });

    const detail = await json(await fetch(`${base}/api/contents/tcg-2026-08-05-abcd`));
    expect(detail.files).toEqual(['thumb-16x9-v1.png', 'video.mp4']);
    expect(detail.costByModule).toEqual({ edl: 0.04 });
    expect((await fetch(`${base}/api/contents/inconnu`)).status).toBe(404);
  });

  it('sert la vidéo par plages (lecteur) et refuse tout autre fichier', async () => {
    const part = await fetch(`${base}/media/tcg-2026-08-05-abcd/video.mp4`, {
      headers: { Range: 'bytes=100-199' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const full = await fetch(`${base}/media/tcg-2026-08-05-abcd/video.mp4`);
    expect(full.headers.get('content-length')).toBe('1000');
    expect((await fetch(`${base}/media/tcg-2026-08-05-abcd/account.yaml`)).status).toBe(404);
    expect((await fetch(`${base}/media/tcg-2026-08-05-abcd/..%2F..%2Faccount.yaml`)).status).toBe(
      404,
    );
  });

  it('dépose un fichier dans raw/<compte>/<session> (via .part), refuse les sessions déjà traitées', async () => {
    const up = await fetch(`${base}/api/upload?account=tcg&session=2026-09-27&name=IMG_1.MOV`, {
      method: 'POST',
      body: Buffer.alloc(2048, 1),
    });
    expect(up.status).toBe(200);
    const target = path.join(dir, 'data', 'raw', 'tcg', '2026-09-27');
    expect(fs.readdirSync(target)).toEqual(['IMG_1.MOV']); // plus de .part
    expect(fs.statSync(path.join(target, 'IMG_1.MOV')).size).toBe(2048);

    const again = await fetch(`${base}/api/upload?account=tcg&session=2026-08-05&name=x.mov`, {
      method: 'POST',
      body: 'x',
    });
    expect(again.status).toBe(409); // dossier déjà connu en base
    const badName = await fetch(`${base}/api/upload?account=tcg&session=s&name=..%2Fx.mov`, {
      method: 'POST',
      body: 'x',
    });
    expect(badName.status).toBe(400);
    const badAccount = await fetch(`${base}/api/upload?account=pirate&session=s&name=x.mov`, {
      method: 'POST',
      body: 'x',
    });
    expect(badAccount.status).toBe(400);
  });

  it('actions : feedback et miniatures mis en file, validations, « traiter maintenant »', async () => {
    const empty = await fetch(`${base}/api/contents/tcg-2026-08-05-abcd/feedback`, {
      method: 'POST',
      body: JSON.stringify({ target: 'video', text: '  ' }),
    });
    expect(empty.status).toBe(400);
    const resume = await fetch(`${base}/api/contents/tcg-2026-08-05-abcd/resume`, {
      method: 'POST',
    });
    expect(resume.status).toBe(409); // déjà livré
    const fb = await fetch(`${base}/api/contents/tcg-2026-08-05-abcd/feedback`, {
      method: 'POST',
      body: JSON.stringify({ target: 'thumbnail', text: 'carte plus grande' }),
    });
    expect(fb.status).toBe(202);
    await queue.idle(); // le travail tourne (et échoue ici : pas de rush) sans faire tomber le serveur
    expect(logs.some((l) => l.includes('feedback thumbnail sur tcg-2026-08-05-abcd'))).toBe(true);

    let forced = false;
    const original = control.scanNow.bind(control);
    control.scanNow = () => {
      forced = true;
      original();
    };
    expect((await fetch(`${base}/api/scan`, { method: 'POST' })).status).toBe(202);
    expect(forced).toBe(true);
  });

  it('coûts du mois face au budget, comptes', async () => {
    const costs = await json(await fetch(`${base}/api/costs`));
    expect((costs.monthByAccount as Record<string, number>).tcg).toBeCloseTo(0.04 * 0.92);
    expect((costs.budgets as Record<string, { mode: string }>).tcg!.mode).toBe('threshold');
    const accounts = (await json(await fetch(`${base}/api/accounts`))).accounts as {
      slug: string;
    }[];
    expect(accounts.map((a) => a.slug)).toEqual(['tcg']);
  });
});

describe('safeSegment', () => {
  it('accepte un nom simple, refuse chemins, fichiers cachés et caractères interdits', () => {
    expect(safeSegment('IMG_6211.MOV')).toBe('IMG_6211.MOV');
    expect(safeSegment('2026-09-27')).toBe('2026-09-27');
    expect(safeSegment('../x')).toBeNull();
    expect(safeSegment('a\\b')).toBeNull();
    expect(safeSegment('.processed')).toBeNull();
    expect(safeSegment('a:b')).toBeNull();
    expect(safeSegment('')).toBeNull();
  });
});
