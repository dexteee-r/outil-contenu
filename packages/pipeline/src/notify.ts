import fs from 'node:fs';
import path from 'node:path';
import { retry, type PipelineStep } from '@outil/core';
import type { PipelineContext } from './context.js';
import {
  diskMessage,
  failedMessage,
  postDiscord,
  previewJpeg,
  readyMessage,
  type DiscordFetch,
} from './discord.js';
import type { PipelineState } from './state.js';

/**
 * Notifications « prêt » et « échec » : directement sur Discord (DISCORD_WEBHOOK_URL, miniature en
 * pièce jointe) et/ou en JSON vers des webhooks n8n. Le message doit rester lisible depuis le
 * téléphone même quand le PC est éteint.
 */

export interface ReadyPayload {
  event: 'ready';
  contentId: string;
  account: string;
  title: string;
  thumbnailTitle: string | null;
  durationSec: number;
  readyDir: string;
  files: string[];
  captions: PipelineState['captions'];
  /** Miniature 16:9 en PNG base64, pour la pièce jointe Discord */
  previewBase64: string | null;
}

export interface FailedPayload {
  event: 'failed';
  contentId: string;
  account: string;
  step: PipelineStep;
  error: string;
  workDir: string;
}

export function buildReadyPayload(state: PipelineState): ReadyPayload {
  if (!state.deliveredDir || !state.render) throw new Error('notify : contenu non livré');
  const platforms = state.captions ? Object.values(state.captions) : [];
  const thumbs = state.thumbnails ?? [];
  const preview =
    thumbs.find((t) => t.format === '16x9' && t.selected) ??
    thumbs.find((t) => t.format === '16x9') ??
    thumbs[0];
  return {
    event: 'ready',
    contentId: state.contentId,
    account: state.account,
    title: platforms[0]?.title ?? state.contentId,
    thumbnailTitle: state.thumbnailTitle ?? null,
    durationSec: state.render.durationSec,
    readyDir: state.deliveredDir,
    files: fs.existsSync(state.deliveredDir)
      ? fs
          .readdirSync(state.deliveredDir)
          .filter((f) => fs.statSync(path.join(state.deliveredDir!, f)).isFile())
      : [],
    captions: state.captions,
    previewBase64:
      preview && fs.existsSync(preview.path)
        ? fs.readFileSync(preview.path).toString('base64')
        : null,
  };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** POST JSON vers un webhook, avec nouvelles tentatives sur erreur passagère. */
export async function postWebhook(
  url: string,
  payload: unknown,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<void> {
  await retry(
    async () => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok)
        throw Object.assign(new Error(`webhook HTTP ${res.status}`), { status: res.status });
    },
    { attempts: 4, baseDelayMs: 1000 },
  );
}

export interface NotifyTransport {
  /** POST JSON (n8n) */
  fetchJson?: FetchLike | undefined;
  /** POST multipart (Discord) */
  fetchDiscord?: DiscordFetch | undefined;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Alerte « prêt » vers Discord et/ou n8n, selon ce qui est configuré. Une panne d'envoi est
 * journalisée mais ne fait pas échouer le contenu : la vidéo est livrée, c'est l'essentiel.
 */
export async function notifyReady(
  p: PipelineContext,
  state: PipelineState,
  transport: NotifyTransport = {},
): Promise<void> {
  const { DISCORD_WEBHOOK_URL: discord, N8N_WEBHOOK_READY_URL: n8n } = p.ctx.env;
  const payload = buildReadyPayload(state);
  if (!discord && !n8n) {
    p.log(`notify : aucun webhook configuré — pas d'alerte (contenu prêt : ${payload.readyDir})`);
    return;
  }
  if (discord) {
    try {
      const preview = payload.previewBase64
        ? await previewJpeg(Buffer.from(payload.previewBase64, 'base64'))
        : null;
      await postDiscord(discord, readyMessage(payload, preview), transport.fetchDiscord);
      p.log('notify : message « prêt » envoyé sur Discord');
    } catch (err) {
      p.log(
        `notify : Discord injoignable (${errorText(err)}) — contenu prêt : ${payload.readyDir}`,
      );
    }
  }
  if (n8n) {
    try {
      await postWebhook(n8n, payload, transport.fetchJson);
      p.log(`notify : alerte « prêt » envoyée à n8n (${payload.files.length} fichiers)`);
    } catch (err) {
      p.log(`notify : n8n injoignable (${errorText(err)})`);
    }
  }
}

/** Alerte « disque presque plein » (Discord seulement) ; ne lève jamais. */
export async function notifyDisk(
  p: PipelineContext,
  disk: { freeGb: number; totalGb: number },
  transport: NotifyTransport = {},
): Promise<void> {
  const url = p.ctx.env.DISCORD_WEBHOOK_URL;
  p.log(`disque : moins de ${p.ctx.env.DISK_ALERT_FREE_GB} Go libres`);
  if (!url) return;
  try {
    await postDiscord(url, diskMessage(disk, p.ctx.paths.root), transport.fetchDiscord);
  } catch (err) {
    p.log(`notify : impossible d'envoyer l'alerte disque (${errorText(err)})`);
  }
}

/** Alerte d'échec : ne lève jamais (une panne du webhook ne doit pas masquer l'erreur d'origine). */
export async function notifyFailed(
  p: PipelineContext,
  payload: FailedPayload,
  transport: NotifyTransport = {},
): Promise<void> {
  const { DISCORD_WEBHOOK_URL: discord, N8N_WEBHOOK_FAILED_URL: n8n } = p.ctx.env;
  if (!discord && !n8n) {
    p.log(
      `notify : aucun webhook configuré — échec non relayé (${payload.step} : ${payload.error})`,
    );
    return;
  }
  if (discord) {
    try {
      await postDiscord(discord, failedMessage(payload), transport.fetchDiscord);
      p.log('notify : message « échec » envoyé sur Discord');
    } catch (err) {
      p.log(`notify : impossible d'envoyer l'échec sur Discord (${errorText(err)})`);
    }
  }
  if (n8n) {
    try {
      await postWebhook(n8n, payload, transport.fetchJson);
      p.log('notify : alerte « échec » envoyée à n8n');
    } catch (err) {
      p.log(`notify : impossible d'envoyer l'alerte d'échec à n8n (${errorText(err)})`);
    }
  }
}
