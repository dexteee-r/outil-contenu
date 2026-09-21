import { retry, type RetryOptions } from './retry.js';
import type { ApiCallMeta, UsageTracker } from './usage.js';

/**
 * kie.ai — passerelle payante à l'usage vers plusieurs modèles d'image (GPT Image 2, Nano Banana,
 * Seedream, Ideogram…) derrière une seule clé. API asynchrone : créer une tâche, interroger son
 * état, télécharger le résultat (URL valable 24 h). Le coût est exact : crédits consommés × prix du crédit.
 * Doc : https://docs.kie.ai/market/quickstart
 */

export const KIE_BASE_URL = 'https://api.kie.ai';
/** 200 crédits = 1 $ (grille kie.ai, 2026-09) */
export const KIE_USD_PER_CREDIT = 0.005;

export type KieAspectRatio = '9:16' | '16:9' | '1:1';

interface KieModelSpec {
  /** Valeur du champ `model` de l'API */
  model: string;
  /** Construit l'objet `input` du modèle */
  input: (prompt: string, aspect: KieAspectRatio) => Record<string, unknown>;
}

/** Alias courts → modèles kie.ai, avec leurs paramètres propres (voir docs.kie.ai/market). */
export const KIE_IMAGE_MODELS: Record<string, KieModelSpec> = {
  'gpt-image-2': {
    model: 'gpt-image-2-text-to-image',
    input: (prompt, aspect) => ({ prompt, aspect_ratio: aspect, resolution: '1K' }),
  },
  'nano-banana-pro': {
    model: 'nano-banana-pro',
    input: (prompt, aspect) => ({
      prompt,
      image_input: [],
      aspect_ratio: aspect,
      resolution: '1K',
      output_format: 'png',
    }),
  },
  'seedream-4.5': {
    model: 'seedream/4.5-text-to-image',
    input: (prompt, aspect) => ({
      prompt,
      aspect_ratio: aspect,
      quality: 'basic',
      nsfw_checker: false,
    }),
  },
  'ideogram-v3': {
    model: 'ideogram/v3-text-to-image',
    input: (prompt, aspect) => ({
      prompt,
      image_size:
        aspect === '9:16' ? 'portrait_16_9' : aspect === '16:9' ? 'landscape_16_9' : 'square_hd',
      rendering_speed: 'BALANCED',
      style: 'AUTO',
      expand_prompt: false,
    }),
  },
};

export type KieTaskState = 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';

export interface KieTaskRecord {
  taskId: string;
  state: KieTaskState;
  resultJson?: string | undefined;
  failCode?: string | undefined;
  failMsg?: string | undefined;
  costTime?: number | undefined;
  creditsConsumed?: number | undefined;
}

interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

export class KieError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'KieError';
  }
}

/** Sous-ensemble de `fetch` injectable dans les tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}>;

export interface KieProviderOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Intervalle d'interrogation de la tâche (défaut 3 s) */
  pollIntervalMs?: number;
  /** Abandon au-delà (défaut 10 min, recommandation kie.ai) */
  timeoutMs?: number;
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'onRetry'>;
}

export interface KieImageResult {
  image: Buffer;
  mimeType: string;
  url: string;
  creditsConsumed: number;
  costUsd: number;
  /** Temps de génération côté kie.ai, en ms */
  generationMs: number | undefined;
}

/** Interprète `resultJson` (chaîne JSON) et renvoie la première URL. */
export function parseResultUrls(resultJson: string | undefined): string[] {
  if (!resultJson) return [];
  const parsed = JSON.parse(resultJson) as { resultUrls?: unknown };
  return Array.isArray(parsed.resultUrls)
    ? parsed.resultUrls.filter((u): u is string => typeof u === 'string')
    : [];
}

export class KieProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly apiKey: string,
    private readonly tracker: UsageTracker,
    options: KieProviderOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? KIE_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.retryOptions = { ...options.retry, sleep: this.sleep };
  }

  private async call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return retry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const envelope = (await res.json()) as KieEnvelope<T>;
      // kie.ai renvoie le code métier dans le corps (200 = ok, 402 = crédits insuffisants, 429 = trop de requêtes…)
      const code = envelope.code ?? res.status;
      if (code !== 200 || envelope.data === undefined) {
        throw new KieError(`kie.ai ${code} : ${envelope.msg ?? 'sans message'}`, code);
      }
      return envelope.data;
    }, this.retryOptions);
  }

  /** Crédits restants sur le compte. */
  async credits(): Promise<number> {
    const data = await this.call<number | { credits?: number }>('/api/v1/chat/credit');
    return typeof data === 'number' ? data : (data.credits ?? 0);
  }

  async createTask(model: string, input: Record<string, unknown>): Promise<string> {
    const data = await this.call<{ taskId: string }>('/api/v1/jobs/createTask', {
      method: 'POST',
      body: { model, input },
    });
    return data.taskId;
  }

  async getTask(taskId: string): Promise<KieTaskRecord> {
    return this.call<KieTaskRecord>(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  }

  /** Attend la fin d'une tâche (success ou fail), avec délai maximal. */
  async waitForTask(taskId: string): Promise<KieTaskRecord> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const task = await this.getTask(taskId);
      if (task.state === 'success') return task;
      if (task.state === 'fail') {
        throw new KieError(
          `génération échouée (${task.failCode ?? '?'}) : ${task.failMsg ?? 'sans message'}`,
          501,
        );
      }
      if (Date.now() > deadline)
        throw new KieError(
          `tâche ${taskId} toujours ${task.state} après ${this.timeoutMs / 1000} s`,
          408,
        );
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Génère une image : `model` est un alias de KIE_IMAGE_MODELS ou un identifiant kie.ai brut. */
  async generateImage(params: {
    model: string;
    prompt: string;
    aspectRatio: KieAspectRatio;
    meta: ApiCallMeta;
  }): Promise<KieImageResult> {
    const spec = KIE_IMAGE_MODELS[params.model] ?? {
      model: params.model,
      input: (prompt: string, aspect: KieAspectRatio) => ({ prompt, aspect_ratio: aspect }),
    };
    return this.tracker.track(params.meta, async () => {
      const taskId = await this.createTask(
        spec.model,
        spec.input(params.prompt, params.aspectRatio),
      );
      const task = await this.waitForTask(taskId);
      const url = parseResultUrls(task.resultJson)[0];
      if (!url) throw new KieError('tâche réussie mais sans URL de résultat', 500);
      const res = await retry(() => this.fetchImpl(url), this.retryOptions);
      if (!res.ok)
        throw new KieError(`téléchargement du résultat : HTTP ${res.status}`, res.status);
      const image = Buffer.from(await res.arrayBuffer());
      const creditsConsumed = task.creditsConsumed ?? 0;
      const costUsd = creditsConsumed * KIE_USD_PER_CREDIT;
      const result: KieImageResult = {
        image,
        mimeType: res.headers.get('content-type') ?? 'image/png',
        url,
        creditsConsumed,
        costUsd,
        generationMs: task.costTime,
      };
      return { result, usage: { images: 1 }, costUsd };
    });
  }
}
