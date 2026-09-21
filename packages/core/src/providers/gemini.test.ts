import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeDb, openDb, type Db } from '../db/index.js';
import { apiCalls } from '../db/schema.js';
import {
  GeminiOutputError,
  GeminiProvider,
  usageFromMetadata,
  videoMimeType,
  type GeminiFile,
  type GeminiGenerateParams,
  type GeminiResponse,
  type GeminiSdk,
} from './gemini.js';
import { UsageTracker } from './usage.js';

const PRICING = { 'gemini-test': { kind: 'tokens' as const, inputPerMTok: 1, outputPerMTok: 4 } };

function fakeSdk(overrides: {
  upload?: GeminiFile;
  gets?: GeminiFile[];
  response?: GeminiResponse;
  onGenerate?: (p: GeminiGenerateParams) => void;
}): GeminiSdk & { calls: { get: number } } {
  const gets = [...(overrides.gets ?? [])];
  const calls = { get: 0 };
  return {
    calls,
    files: {
      upload: () =>
        Promise.resolve(overrides.upload ?? { name: 'files/x', uri: 'gs://x', state: 'ACTIVE' }),
      get: () => {
        calls.get++;
        return Promise.resolve(gets.shift() ?? { name: 'files/x', uri: 'gs://x', state: 'ACTIVE' });
      },
    },
    models: {
      generateContent: (p) => {
        overrides.onGenerate?.(p);
        return Promise.resolve(overrides.response ?? { text: '{}' });
      },
    },
  };
}

let db: Db | undefined;
afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const provider = (sdk: GeminiSdk) => {
  db = openDb({ file: ':memory:' });
  const tracker = new UsageTracker(db, { pricing: PRICING, usdEurRate: 1 });
  return new GeminiProvider(sdk, tracker, { pollIntervalMs: 1, sleep: () => Promise.resolve() });
};

describe('videoMimeType / usageFromMetadata', () => {
  it('reconnaît les conteneurs vidéo courants', () => {
    expect(videoMimeType('a.MP4')).toBe('video/mp4');
    expect(videoMimeType('b.mov')).toBe('video/quicktime');
    expect(() => videoMimeType('c.txt')).toThrow(/non pris en charge/);
  });

  it('additionne réponse et réflexion dans les tokens de sortie', () => {
    expect(
      usageFromMetadata({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 }),
    ).toEqual({ inputTokens: 10, outputTokens: 12 });
    expect(usageFromMetadata(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('GeminiProvider.uploadFile', () => {
  it('attend l’état ACTIVE en interrogeant files.get', async () => {
    const sdk = fakeSdk({
      upload: { name: 'files/x', state: 'PROCESSING' },
      gets: [
        { name: 'files/x', state: 'PROCESSING' },
        { name: 'files/x', uri: 'gs://x', mimeType: 'video/mp4', state: 'ACTIVE' },
      ],
    });
    const file = await provider(sdk).uploadFile('rush.mp4', 'video/mp4');
    expect(file).toEqual({ uri: 'gs://x', mimeType: 'video/mp4', name: 'files/x' });
    expect(sdk.calls.get).toBe(2);
  });

  it('échoue proprement si le fichier est FAILED', async () => {
    const sdk = fakeSdk({
      upload: { name: 'files/x', state: 'FAILED', error: { message: 'codec' } },
    });
    await expect(provider(sdk).uploadFile('rush.mp4', 'video/mp4')).rejects.toThrow(
      /FAILED — codec/,
    );
  });
});

describe('GeminiProvider.generateJson', () => {
  const schema = z.object({ ok: z.boolean() }).strict();

  it('envoie le JSON Schema, valide la réponse et journalise le coût', async () => {
    let sent: GeminiGenerateParams | undefined;
    const sdk = fakeSdk({
      onGenerate: (p) => (sent = p),
      response: {
        text: '{"ok":true}',
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 250_000 },
      },
    });
    const out = await provider(sdk).generateJson({
      model: 'gemini-test',
      schema,
      parts: [{ text: 'salut' }],
      meta: { module: 'tagging', provider: 'gemini', model: 'gemini-test', account: 'tcg' },
    });
    expect(out.data).toEqual({ ok: true });
    expect(out.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 250_000 });
    expect(sent?.config?.responseMimeType).toBe('application/json');
    expect(sent?.config?.responseJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const row = db!.select().from(apiCalls).get();
    expect(row).toMatchObject({
      module: 'tagging',
      model: 'gemini-test',
      inputTokens: 1_000_000,
      costUsd: 2,
      status: 'ok',
    });
  });

  it('lève GeminiOutputError (avec le brut) si la réponse n’est pas du JSON ou hors schéma', async () => {
    const notJson = provider(fakeSdk({ response: { text: 'oops' } }));
    await expect(
      notJson.generateJson({
        model: 'gemini-test',
        schema,
        parts: [],
        meta: { module: 'tagging', provider: 'gemini', model: 'gemini-test' },
      }),
    ).rejects.toMatchObject({ name: 'GeminiOutputError', raw: 'oops' });

    const offSchema = provider(fakeSdk({ response: { text: '{"ok":"oui"}' } }));
    await expect(
      offSchema.generateJson({
        model: 'gemini-test',
        schema,
        parts: [],
        meta: { module: 'tagging', provider: 'gemini', model: 'gemini-test' },
      }),
    ).rejects.toThrow(GeminiOutputError);
    expect(
      db!
        .select()
        .from(apiCalls)
        .all()
        .map((r) => r.status),
    ).toEqual(['error']);
  });
});

describe('GeminiProvider — nouvelles tentatives', () => {
  const schema = z.object({ ok: z.boolean() }).strict();
  const meta = { module: 'tagging', provider: 'gemini', model: 'gemini-test' } as const;

  it('rejoue un 503 puis réussit, une seule ligne api_calls', async () => {
    let calls = 0;
    const sdk = fakeSdk({});
    sdk.models.generateContent = () => {
      calls++;
      return calls < 3
        ? Promise.reject(Object.assign(new Error('high demand'), { status: 503 }))
        : Promise.resolve({ text: '{"ok":true}' });
    };
    const retries: number[] = [];
    db = openDb({ file: ':memory:' });
    const tracker = new UsageTracker(db, { pricing: PRICING, usdEurRate: 1 });
    const p = new GeminiProvider(sdk, tracker, {
      sleep: () => Promise.resolve(),
      retry: { onRetry: (i) => retries.push(i.attempt) },
    });
    const out = await p.generateJson({ model: 'gemini-test', schema, parts: [], meta });
    expect(out.data).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(db.select().from(apiCalls).all()).toHaveLength(1);
  });

  it('ne rejoue pas une réponse hors schéma', async () => {
    let calls = 0;
    const sdk = fakeSdk({});
    sdk.models.generateContent = () => {
      calls++;
      return Promise.resolve({ text: '{"ok":"non"}' });
    };
    await expect(
      provider(sdk).generateJson({ model: 'gemini-test', schema, parts: [], meta }),
    ).rejects.toThrow(GeminiOutputError);
    expect(calls).toBe(1);
  });
});

describe('GeminiProvider.generateImages', () => {
  it('décode les images inline et compte les images dans l’usage', async () => {
    const png = Buffer.from('fake-png');
    const sdk = fakeSdk({
      response: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'voici' },
                { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
      },
    });
    const out = await provider(sdk).generateImages({
      model: 'gemini-test',
      prompt: 'une carte',
      aspectRatio: '9:16',
      meta: { module: 'image', provider: 'gemini', model: 'gemini-test' },
    });
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.data.equals(png)).toBe(true);
    expect(out.text).toBe('voici');
    expect(db!.select().from(apiCalls).get()?.images).toBe(1);
  });

  it('échoue si aucune image', async () => {
    const sdk = fakeSdk({
      response: { candidates: [{ content: { parts: [{ text: 'refus' }] } }] },
    });
    await expect(
      provider(sdk).generateImages({
        model: 'gemini-test',
        prompt: 'x',
        meta: { module: 'image', provider: 'gemini', model: 'gemini-test' },
      }),
    ).rejects.toThrow(/aucune image/);
  });
});
