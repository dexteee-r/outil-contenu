import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  loadAccount,
  loadReferenceClips,
  loadReferenceEdl,
  makeSyntheticClip,
  openDb,
  UsageTracker,
  type Db,
  type TaggingResult,
} from '@outil/core';
import { AnthropicProvider, type AnthropicSdk } from '@outil/core';
import { createPipelineContext, type PipelineContext } from '../context.js';
import { makeContentId, isVideoFile } from '../ids.js';
import { buildReadyPayload, postWebhook } from '../notify.js';
import { saveState, type PipelineState } from '../state.js';
import { makeTestContext, writeTestAccount } from '../test-helpers.js';
import { buildEdlRequest, edl, taggingForPrompt } from './edl.js';
import { buildMetadata } from './deliver.js';
import { checkOutputs } from './qc.js';
import {
  buildBackgroundPrompt,
  framingAt,
  keyFrameCandidates,
  pickKeyMoment,
  thumbnail,
} from './thumbnail.js';

const clips = loadReferenceClips();
const referenceEdl = loadReferenceEdl();

const tagging: TaggingResult = {
  clips: clips.map((c) => ({
    ...c,
    summary: `résumé ${c.id}`,
    scenes: [
      { start: 0, end: c.durationSec, description: `scène de ${c.id}`, tags: [], audioEvents: [] },
    ],
    transcript: [],
  })),
  highlights: [
    { clipId: 'rush-01', start: 27.5, end: 33, score: 0.9, kind: 'climax', reason: 'la carte' },
    { clipId: 'rush-01', start: 0, end: 2, score: 0.6, kind: 'hook', reason: 'booster' },
  ],
  summary: 'Ouverture TCG.',
  model: 'gemini-test',
  taggedAt: '2026-09-21T10:00:00.000Z',
};

describe('ids', () => {
  it('prend la date du dossier /raw quand il est daté, sinon le jour courant', () => {
    expect(
      makeContentId('tcg', 'E:\\contenu\\raw\\tcg\\2026-08-05', new Date('2026-09-21'), 'a3f9'),
    ).toBe('tcg-2026-08-05-a3f9');
    expect(
      makeContentId('tcg', '/raw/tcg/vacances', new Date('2026-09-21T10:00:00Z'), 'a3f9'),
    ).toBe('tcg-2026-09-21-a3f9');
    expect(makeContentId('tcg', '/raw/tcg/x').length).toBe('tcg-2026-09-21-'.length + 4);
  });

  it('reconnaît les fichiers vidéo', () => {
    expect(isVideoFile('IMG_1.MOV')).toBe(true);
    expect(isVideoFile('brief.txt')).toBe(false);
  });
});

describe('qc.checkOutputs', () => {
  const good = {
    durationSec: 25.7,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    codec: 'h264',
    rotation: 0,
  };
  const thumbs = [
    { format: '9x16' as const, width: 1080, height: 1920 },
    { format: '16x9' as const, width: 1280, height: 720 },
  ];
  it('accepte une sortie conforme', () => {
    expect(
      checkOutputs({
        video: good,
        expectedDurationSec: 25.67,
        durationRange: { min: 15, max: 60 },
        thumbnails: thumbs,
      }),
    ).toEqual([]);
  });
  it('signale dimensions, audio, durée et miniatures', () => {
    const issues = checkOutputs({
      video: { ...good, width: 1920, height: 1080, hasAudio: false, durationSec: 70 },
      expectedDurationSec: 25,
      durationRange: { min: 15, max: 60 },
      thumbnails: [{ format: '9x16', width: 100, height: 100 }],
    });
    expect(issues).toHaveLength(5);
    expect(issues.join(' ')).toMatch(/1920x1080/);
    expect(issues.join(' ')).toMatch(/sans piste audio/);
    expect(issues.join(' ')).toMatch(/hors plage/);
    expect(issues.join(' ')).toMatch(/miniature 9x16/);
  });
});

describe('edl step', () => {
  let dir: string;
  let db: Db;
  afterEach(() => {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renvoie les problèmes au modèle et accepte l’EDL corrigé', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-edl-'));
    writeTestAccount(dir, 'tcg');
    const ctx = makeTestContext(dir);
    db = openDb({ file: ':memory:' });
    const p = createPipelineContext(ctx, db, () => {});
    const bad = {
      ...referenceEdl,
      segments: [{ ...referenceEdl.segments[0]!, clipId: 'rush-99', in: 0, out: 20 }],
    };
    const responses = [bad, referenceEdl];
    const sent: { messages: { role: string; content: string }[] }[] = [];
    const sdk: AnthropicSdk = {
      messages: {
        parse: (params) => {
          sent.push({ messages: params.messages });
          const out = responses.shift();
          return Promise.resolve({
            parsed_output: out,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(out) }],
          });
        },
      },
    };
    const fake = new AnthropicProvider(sdk, new UsageTracker(db, { pricing: {}, usdEurRate: 1 }));
    const pctx: PipelineContext = { ...p, anthropic: () => fake };
    const state: PipelineState = {
      version: 1,
      contentId: 'tcg-x',
      account: 'tcg',
      sourceDir: dir,
      workDir: path.join(dir, 'work'),
      createdAt: new Date().toISOString(),
      completedSteps: ['ingest', 'tag'],
      sourceFiles: [],
      clips,
      tagging,
    };
    fs.mkdirSync(state.workDir, { recursive: true });
    await edl(pctx, state, loadAccount('tcg', ctx.accountsDir));
    expect(state.edl).toEqual(referenceEdl);
    expect(state.edlAttempts).toBe(2);
    expect(sent[1]!.messages).toHaveLength(3);
    expect(sent[1]!.messages[2]!.content).toContain('clipId "rush-99" inconnu');
    expect(fs.existsSync(path.join(state.workDir, 'edl.json'))).toBe(true);
  });

  it('construit une requête avec les contraintes et le dérushage compacté', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-edl-'));
    writeTestAccount(dir, 'tcg');
    db = openDb({ file: ':memory:' });
    const account = loadAccount('tcg', makeTestContext(dir).accountsDir);
    const text = buildEdlRequest(account, tagging);
    expect(text).toContain('durationRange : 15 à 60 secondes');
    expect(text).toContain('musicMoods disponibles : hype');
    expect(text).toContain('"clipId": "rush-01"');
    expect(JSON.stringify(taggingForPrompt(tagging))).not.toContain('source/rush-01.mp4');
  });
});

describe('thumbnail step (repli image clé, ffmpeg réel)', () => {
  let dir: string;
  let db: Db;
  afterEach(() => {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('choisit le climax, extrait la frame, compose les deux formats', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-thumb-'));
    writeTestAccount(dir, 'tcg');
    const ctx = makeTestContext(dir, { IMAGE_PROVIDER: 'gemini' }); // pas de kie → repli
    db = openDb({ file: ':memory:' });
    const p = createPipelineContext(ctx, db, () => {});
    const clip = await makeSyntheticClip({
      out: path.join(dir, 'rush-01.mp4'),
      durationSec: 3,
      width: 540,
      height: 960,
      fps: 24,
    });
    const state: PipelineState = {
      version: 1,
      contentId: 'tcg-x',
      account: 'tcg',
      sourceDir: dir,
      workDir: path.join(dir, 'work'),
      createdAt: new Date().toISOString(),
      completedSteps: ['ingest', 'tag', 'edl', 'render', 'captions'],
      sourceFiles: ['rush-01.mp4'],
      clips: [
        { id: 'rush-01', path: clip, durationSec: 3, width: 540, height: 960, hasAudio: true },
      ],
      tagging: {
        ...tagging,
        highlights: [
          { clipId: 'rush-01', start: 1, end: 2.5, score: 0.9, kind: 'climax', reason: 'x' },
        ],
      },
      thumbnailTitle: 'PULL VERGO',
    };
    fs.mkdirSync(state.workDir, { recursive: true });
    await thumbnail(p, state, loadAccount('tcg', ctx.accountsDir));
    expect(state.thumbnails).toHaveLength(2);
    expect(state.thumbnails!.every((t) => t.background === 'frame' && fs.existsSync(t.path))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(state.workDir, 'key-frame.png'))).toBe(true);
  }, 60_000);

  it('candidats d’image clé et cadrage du segment couvrant', () => {
    const moment = {
      clipId: 'rush-01',
      start: 27.5,
      end: 33,
      score: 0.9,
      kind: 'climax' as const,
      reason: 'x',
    };
    const cands = keyFrameCandidates(moment, 42);
    expect(cands[0]).toBeCloseTo(32.7);
    expect(cands.every((t) => t >= 27.5 && t <= 33)).toBe(true);
    expect(keyFrameCandidates({ ...moment, end: 50 }, 42).every((t) => t <= 41.9)).toBe(true);
    expect(framingAt(referenceEdl, 'rush-01', 30)).toEqual({ zoom: 1.3, focusX: 0.5, focusY: 0.5 }); // 1.6 plafonné
    expect(framingAt(referenceEdl, 'rush-02', 5).zoom).toBe(1.2);
    expect(framingAt(referenceEdl, 'rush-01', 4)).toEqual({ zoom: 1, focusX: 0.5, focusY: 0.5 });
    expect(framingAt(undefined, 'rush-01', 30).zoom).toBe(1);
  });

  it('pickKeyMoment et buildBackgroundPrompt', () => {
    expect(pickKeyMoment(tagging)?.kind).toBe('climax');
    expect(pickKeyMoment({ ...tagging, highlights: [] })).toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-thumb-'));
    writeTestAccount(dir, 'tcg');
    db = openDb({ file: ':memory:' });
    const account = loadAccount('tcg', makeTestContext(dir).accountsDir);
    const prompt = buildBackgroundPrompt(account, tagging, pickKeyMoment(tagging));
    expect(prompt).toContain('scène de rush-01');
    expect(prompt).toContain('#FFCC00');
    expect(prompt).toMatch(/Aucun texte/);
  });
});

describe('deliver.buildMetadata / notify', () => {
  it('produit un metadata.json valide avec la mention IA', () => {
    const state: PipelineState = {
      version: 1,
      contentId: 'tcg-2026-08-05-abcd',
      account: 'tcg',
      sourceDir: '/raw',
      workDir: '/work',
      createdAt: new Date().toISOString(),
      completedSteps: [],
      sourceFiles: ['part 1.MOV'],
      render: {
        path: '/work/video.mp4',
        durationSec: 25.7,
        width: 1080,
        height: 1920,
        renderMs: 30000,
      },
      captions: { 'youtube-shorts': { title: 'Titre', description: 'd', hashtags: ['#Shorts'] } },
      thumbnails: [
        {
          path: '/work/thumb-9x16-v1.png',
          format: '9x16',
          variant: 1,
          selected: true,
          background: 'ai',
        },
      ],
      models: {
        tagging: 'gemini-x',
        edl: 'claude-sonnet-5',
        captions: 'claude-sonnet-5',
        image: 'gpt-image-2',
      },
    };
    const meta = buildMetadata(state, {
      video: 'video.mp4',
      thumbnails: [{ path: 'thumb-9x16-v1.png', format: '9x16', variant: 1, selected: true }],
    });
    expect(meta.aiDisclosure).toEqual({
      video: false,
      images: true,
      providers: ['gemini', 'anthropic', 'kie'],
    });
    expect(meta.sourceFiles).toEqual(['part 1.MOV']);
  });

  it('construit la charge utile « prêt » avec l’aperçu 16:9 et poste au webhook', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-notify-'));
    try {
      const ready = path.join(dir, 'ready');
      fs.mkdirSync(ready);
      fs.writeFileSync(path.join(ready, 'video.mp4'), 'v');
      fs.writeFileSync(path.join(ready, 'thumb-16x9-v1.png'), 'img');
      const state: PipelineState = {
        version: 1,
        contentId: 'c',
        account: 'tcg',
        sourceDir: dir,
        workDir: ready,
        createdAt: new Date().toISOString(),
        completedSteps: [],
        sourceFiles: [],
        deliveredDir: ready,
        render: {
          path: path.join(ready, 'video.mp4'),
          durationSec: 20,
          width: 1080,
          height: 1920,
          renderMs: 1,
        },
        captions: { tiktok: { title: 'Le titre', description: '', hashtags: [] } },
        thumbnails: [
          {
            path: path.join(ready, 'thumb-16x9-v1.png'),
            format: '16x9',
            variant: 1,
            selected: true,
            background: 'frame',
          },
        ],
        thumbnailTitle: 'PULL',
      };
      const payload = buildReadyPayload(state);
      expect(payload).toMatchObject({
        event: 'ready',
        title: 'Le titre',
        files: ['thumb-16x9-v1.png', 'video.mp4'],
      });
      expect(payload.previewBase64).toBe(Buffer.from('img').toString('base64'));

      const calls: { url: string; body: string }[] = [];
      await postWebhook('https://n8n.test/ready', payload, (url, init) => {
        calls.push({ url, body: init.body });
        return Promise.resolve({ ok: true, status: 200 });
      });
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.body)).toMatchObject({ contentId: 'c' });
      await expect(
        postWebhook('https://n8n.test/ready', payload, () =>
          Promise.resolve({ ok: false, status: 404 }),
        ),
      ).rejects.toThrow(/404/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('state', () => {
  it('sauvegarde et recharge l’état, refuse un état invalide', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-state-'));
    try {
      const state: PipelineState = {
        version: 1,
        contentId: 'c',
        account: 'tcg',
        sourceDir: dir,
        workDir: path.join(dir, 'w'),
        createdAt: new Date().toISOString(),
        completedSteps: ['ingest'],
        sourceFiles: ['a.mov'],
        clips,
        edl: referenceEdl,
      };
      saveState(state);
      expect(fs.existsSync(path.join(dir, 'w', 'state.json'))).toBe(true);
      expect(() => saveState({ ...state, completedSteps: ['mystère' as never] })).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
