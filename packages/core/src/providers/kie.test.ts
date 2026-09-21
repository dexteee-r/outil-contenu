import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../db/index.js';
import { apiCalls } from '../db/schema.js';
import {
  KIE_IMAGE_MODELS,
  KieError,
  KieProvider,
  parseResultUrls,
  type FetchLike,
  type KieTaskRecord,
} from './kie.js';
import { UsageTracker } from './usage.js';

type Call = { url: string; method: string; body?: unknown };

/** Faux serveur kie.ai : séquence d'états pour la tâche, image binaire à télécharger. */
function fakeKie(options: {
  states: Partial<KieTaskRecord>[];
  createCode?: number;
  image?: Buffer;
}) {
  const calls: Call[] = [];
  const states = [...options.states];
  const image = options.image ?? Buffer.from('PNG-bytes');
  const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    headers: { get: () => 'application/json' },
  });
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith('/api/v1/jobs/createTask')) {
      const code = options.createCode ?? 200;
      return Promise.resolve(
        json(
          code === 200
            ? { code, msg: 'success', data: { taskId: 't-1' } }
            : { code, msg: 'refusé' },
        ),
      );
    }
    if (url.includes('/api/v1/jobs/recordInfo')) {
      const next = states.length > 1 ? states.shift()! : states[0]!;
      return Promise.resolve(
        json({ code: 200, data: { taskId: 't-1', state: 'waiting', ...next } }),
      );
    }
    if (url.endsWith('/api/v1/chat/credit'))
      return Promise.resolve(json({ code: 200, data: 1234 }));
    if (url.startsWith('https://cdn.test/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('binaire')),
        arrayBuffer: () => Promise.resolve(new Uint8Array(image).buffer),
        headers: { get: () => 'image/png' },
      });
    }
    return Promise.resolve(json({ code: 404, msg: 'inconnu' }));
  };
  return { fetch, calls };
}

let db: Db | undefined;
afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const provider = (fetch: FetchLike) => {
  db = openDb({ file: ':memory:' });
  const tracker = new UsageTracker(db, { pricing: {}, usdEurRate: 0.5 });
  return new KieProvider('sk-test', tracker, {
    fetch,
    sleep: () => Promise.resolve(),
    pollIntervalMs: 1,
    timeoutMs: 10_000,
  });
};
const meta = { module: 'image', provider: 'kie', model: 'gpt-image-2' } as const;

describe('parseResultUrls / KIE_IMAGE_MODELS', () => {
  it('lit les URLs du resultJson', () => {
    expect(parseResultUrls('{"resultUrls":["https://a","https://b"]}')).toEqual([
      'https://a',
      'https://b',
    ]);
    expect(parseResultUrls(undefined)).toEqual([]);
    expect(parseResultUrls('{"resultObject":{}}')).toEqual([]);
  });

  it('adapte les paramètres de chaque modèle au format demandé', () => {
    expect(KIE_IMAGE_MODELS['gpt-image-2']!.input('x', '9:16')).toEqual({
      prompt: 'x',
      aspect_ratio: '9:16',
      resolution: '1K',
    });
    expect(KIE_IMAGE_MODELS['ideogram-v3']!.input('x', '9:16')).toMatchObject({
      image_size: 'portrait_16_9',
    });
    expect(KIE_IMAGE_MODELS['ideogram-v3']!.input('x', '16:9')).toMatchObject({
      image_size: 'landscape_16_9',
    });
    expect(KIE_IMAGE_MODELS['seedream-4.5']!.model).toBe('seedream/4.5-text-to-image');
  });
});

describe('KieProvider.generateImage', () => {
  it('crée la tâche, attend le succès, télécharge l’image et journalise le coût exact', async () => {
    const png = Buffer.from('fake-png-data');
    const kie = fakeKie({
      states: [
        { state: 'queuing' },
        { state: 'generating' },
        {
          state: 'success',
          resultJson: '{"resultUrls":["https://cdn.test/out.png"]}',
          creditsConsumed: 6,
          costTime: 15000,
        },
      ],
      image: png,
    });
    const out = await provider(kie.fetch).generateImage({
      model: 'gpt-image-2',
      prompt: 'une carte',
      aspectRatio: '9:16',
      meta,
    });
    expect(out.image.equals(png)).toBe(true);
    expect(out).toMatchObject({
      url: 'https://cdn.test/out.png',
      creditsConsumed: 6,
      costUsd: 0.03,
      generationMs: 15000,
      mimeType: 'image/png',
    });

    const create = kie.calls.find((c) => c.url.endsWith('/createTask'));
    expect(create?.body).toEqual({
      model: 'gpt-image-2-text-to-image',
      input: { prompt: 'une carte', aspect_ratio: '9:16', resolution: '1K' },
    });
    expect(kie.calls.filter((c) => c.url.includes('recordInfo'))).toHaveLength(3);

    const row = db!.select().from(apiCalls).get();
    expect(row).toMatchObject({
      provider: 'kie',
      model: 'gpt-image-2',
      images: 1,
      costUsd: 0.03,
      costEur: 0.015,
      status: 'ok',
    });
  });

  it('remonte l’échec de génération avec le message kie.ai', async () => {
    const kie = fakeKie({
      states: [{ state: 'fail', failCode: '501', failMsg: 'contenu refusé' }],
    });
    await expect(
      provider(kie.fetch).generateImage({
        model: 'gpt-image-2',
        prompt: 'x',
        aspectRatio: '1:1',
        meta,
      }),
    ).rejects.toThrow(/contenu refusé/);
    expect(db!.select().from(apiCalls).get()?.status).toBe('error');
  });

  it('refuse proprement quand le compte n’a plus de crédits (402, sans réessayer)', async () => {
    const kie = fakeKie({ states: [], createCode: 402 });
    await expect(
      provider(kie.fetch).generateImage({
        model: 'gpt-image-2',
        prompt: 'x',
        aspectRatio: '1:1',
        meta,
      }),
    ).rejects.toBeInstanceOf(KieError);
    expect(kie.calls.filter((c) => c.url.endsWith('/createTask'))).toHaveLength(1);
  });

  it('abandonne si la tâche ne finit pas dans le délai', async () => {
    const kie = fakeKie({ states: [{ state: 'generating' }] });
    db = openDb({ file: ':memory:' });
    const tracker = new UsageTracker(db, { pricing: {}, usdEurRate: 1 });
    let now = 0;
    const p = new KieProvider('k', tracker, {
      fetch: kie.fetch,
      sleep: () => {
        now += 5000;
        return Promise.resolve();
      },
      pollIntervalMs: 1,
      timeoutMs: 12_000,
    });
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + now;
    try {
      await expect(
        p.generateImage({ model: 'gpt-image-2', prompt: 'x', aspectRatio: '1:1', meta }),
      ).rejects.toThrow(/toujours generating/);
    } finally {
      Date.now = realNow;
    }
  });

  it('lit les crédits du compte', async () => {
    const kie = fakeKie({ states: [] });
    expect(await provider(kie.fetch).credits()).toBe(1234);
  });
});
