import fs from 'node:fs';
import path from 'node:path';
import { retry, type PipelineStep } from '@outil/core';
import type { PipelineContext } from './context.js';
import type { PipelineState } from './state.js';

/**
 * Notifications : le worker POSTe un JSON à deux webhooks n8n (« prêt », « échec »), n8n route
 * vers Discord. L'aperçu (miniature 16:9) part en base64 : le message doit rester lisible depuis
 * le téléphone même quand le PC est éteint.
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

export async function notifyReady(
  p: PipelineContext,
  state: PipelineState,
  fetchImpl?: FetchLike,
): Promise<void> {
  const url = p.ctx.env.N8N_WEBHOOK_READY_URL;
  const payload = buildReadyPayload(state);
  if (!url) {
    p.log(
      `notify : N8N_WEBHOOK_READY_URL non défini — pas d'alerte (contenu prêt : ${payload.readyDir})`,
    );
    return;
  }
  await postWebhook(url, payload, fetchImpl);
  p.log(`notify : alerte « prêt » envoyée (${payload.files.length} fichiers)`);
}

/** Alerte d'échec : ne lève jamais (une panne du webhook ne doit pas masquer l'erreur d'origine). */
export async function notifyFailed(
  p: PipelineContext,
  payload: FailedPayload,
  fetchImpl?: FetchLike,
): Promise<void> {
  const url = p.ctx.env.N8N_WEBHOOK_FAILED_URL;
  if (!url) {
    p.log(
      `notify : N8N_WEBHOOK_FAILED_URL non défini — échec non relayé (${payload.step} : ${payload.error})`,
    );
    return;
  }
  try {
    await postWebhook(url, payload, fetchImpl);
    p.log('notify : alerte « échec » envoyée');
  } catch (err) {
    p.log(
      `notify : impossible d'envoyer l'alerte d'échec (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
