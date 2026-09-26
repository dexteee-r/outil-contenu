import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '@outil/core';
import { createPipelineContext } from './context.js';
import {
  clip,
  failedMessage,
  postDiscord,
  previewJpeg,
  readyMessage,
  type DiscordFetch,
} from './discord.js';
import { notifyFailed, notifyReady, type FailedPayload, type ReadyPayload } from './notify.js';
import type { PipelineState } from './state.js';
import { makeTestContext } from './test-helpers.js';

const ready: ReadyPayload = {
  event: 'ready',
  contentId: 'tcg-2026-08-05-abcd',
  account: 'tcg',
  title: 'Ouverture OP-10 : la dernière carte change tout',
  thumbnailTitle: 'QUEL HIT ?',
  durationSec: 26.15,
  readyDir: 'E:\\contenu\\ready\\tcg\\tcg-2026-08-05-abcd',
  files: ['video.mp4'],
  captions: {
    tiktok: {
      title: 'Booster OP-10',
      description: 'Vous pensez que c’est quoi ?',
      hashtags: ['tcg', '#onepiece'],
    },
  },
  previewBase64: null,
};

const failed: FailedPayload = {
  event: 'failed',
  contentId: 'tcg-2026-08-05-abcd',
  account: 'tcg',
  step: 'tag',
  error: 'Gemini 429 : quota épuisé',
  workDir: 'E:\\contenu\\processing\\tcg-2026-08-05-abcd',
};

/** Faux Discord : enregistre les formulaires reçus, répond avec les statuts donnés. */
function fakeDiscord(statuses: number[] = [204]) {
  const calls: { url: string; json: Record<string, unknown>; file: File | null }[] = [];
  const fetchImpl: DiscordFetch = (url, init) => {
    const raw = init.body.get('payload_json');
    const json = JSON.parse(typeof raw === 'string' ? raw : '{}') as Record<string, unknown>;
    const file = init.body.get('files[0]');
    calls.push({ url, json, file: file instanceof File ? file : null });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve('') });
  };
  return { calls, fetchImpl };
}

describe('messages Discord', () => {
  it('« prêt » : titre, durée, dossier, légendes par plateforme, miniature en pièce jointe', () => {
    const m = readyMessage(ready, Buffer.from('jpg'));
    expect(m.content).toContain('Vidéo prête');
    const embed = m.embeds[0] as {
      title: string;
      description: string;
      fields: { name: string; value: string }[];
      image: { url: string };
      footer: { text: string };
    };
    expect(embed.title).toBe(ready.title);
    expect(embed.description).toContain('26 s');
    expect(embed.description).toContain('« QUEL HIT ? »');
    expect(embed.description).toContain(ready.readyDir);
    expect(embed.fields).toEqual([
      {
        name: 'TikTok',
        value: '**Booster OP-10**\nVous pensez que c’est quoi ?\n#tcg #onepiece',
      },
    ]);
    expect(embed.image.url).toBe('attachment://miniature.jpg');
    expect(embed.footer.text).toContain('pnpm content feedback tcg-2026-08-05-abcd');
    expect(m.file?.name).toBe('miniature.jpg');
    expect(readyMessage(ready, null).file).toBeUndefined();
  });

  it('« échec » : étape, erreur et commande de reprise', () => {
    const embed = failedMessage(failed).embeds[0] as { fields: { name: string; value: string }[] };
    expect(embed.fields.map((f) => f.name)).toEqual(['Étape', 'Erreur', 'Pour reprendre']);
    expect(embed.fields[1]!.value).toContain('quota épuisé');
    expect(embed.fields[2]!.value).toBe('`pnpm content resume tcg-2026-08-05-abcd`');
  });

  it('respecte les limites de longueur de Discord', () => {
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
    const long = {
      ...ready,
      captions: { tiktok: { title: 't', description: 'x'.repeat(3000), hashtags: [] } },
    };
    const field = (readyMessage(long, null).embeds[0] as { fields: { value: string }[] })
      .fields[0]!;
    expect(field.value.length).toBe(1024);
  });

  it('allège la miniature en JPEG ≤ 1280 px', async () => {
    const png = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: '#406' },
    })
      .png()
      .toBuffer();
    const meta = await sharp(await previewJpeg(png)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1280, 720]);
  });
});

describe('postDiscord', () => {
  it('envoie payload_json + pièce jointe référencée', async () => {
    const { calls, fetchImpl } = fakeDiscord();
    await postDiscord(
      'https://discord.test/hook',
      readyMessage(ready, Buffer.from('jpg')),
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json.attachments).toEqual([{ id: 0, filename: 'miniature.jpg' }]);
    expect(calls[0]!.file?.name).toBe('miniature.jpg');
    expect(calls[0]!.file?.type).toBe('image/jpeg');
  });

  it('réessaie sur 5xx, abandonne sur 4xx', async () => {
    const flaky = fakeDiscord([502, 204]);
    await postDiscord('https://discord.test/hook', failedMessage(failed), flaky.fetchImpl);
    expect(flaky.calls).toHaveLength(2);
    const bad = fakeDiscord([401]);
    await expect(
      postDiscord('https://discord.test/hook', failedMessage(failed), bad.fetchImpl),
    ).rejects.toThrow(/401/);
    expect(bad.calls).toHaveLength(1);
  }, 20_000);
});

describe('notifyReady / notifyFailed', () => {
  let dir: string;
  let db: Db;
  afterEach(() => {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('envoie sur Discord quand le webhook est configuré, sans faire échouer le contenu si Discord tombe', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-discord-'));
    db = openDb({ file: ':memory:' });
    const logs: string[] = [];
    const ctx = makeTestContext(dir, { DISCORD_WEBHOOK_URL: 'https://discord.test/hook' });
    const p = createPipelineContext(ctx, db, (m) => logs.push(m));
    const readyDir = path.join(dir, 'ready');
    fs.mkdirSync(readyDir);
    const thumb = path.join(readyDir, 'thumb-16x9-v1.png');
    await sharp({ create: { width: 64, height: 36, channels: 3, background: '#406' } }).toFile(
      thumb,
    );
    const state = {
      contentId: 'c',
      account: 'tcg',
      deliveredDir: readyDir,
      render: { path: 'v.mp4', durationSec: 20, width: 1080, height: 1920, renderMs: 1 },
      captions: ready.captions,
      thumbnails: [
        { path: thumb, format: '16x9', variant: 1, selected: true, background: 'frame' },
      ],
    } as PipelineState;

    const ok = fakeDiscord();
    await notifyReady(p, state, { fetchDiscord: ok.fetchImpl });
    expect(ok.calls[0]!.file?.type).toBe('image/jpeg');
    expect(logs.at(-1)).toContain('envoyé sur Discord');

    const down = fakeDiscord([403]);
    await expect(notifyReady(p, state, { fetchDiscord: down.fetchImpl })).resolves.toBeUndefined();
    expect(logs.at(-1)).toContain('Discord injoignable');

    const fail = fakeDiscord();
    await notifyFailed(p, failed, { fetchDiscord: fail.fetchImpl });
    expect(fail.calls[0]!.json.content).toContain('Échec');
  });

  it('sans webhook : journalise seulement', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-discord-'));
    db = openDb({ file: ':memory:' });
    const logs: string[] = [];
    const p = createPipelineContext(makeTestContext(dir), db, (m) => logs.push(m));
    await notifyFailed(p, failed);
    expect(logs.at(-1)).toContain('aucun webhook configuré');
  });
});
