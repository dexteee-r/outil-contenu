import path from 'node:path';
import type { z } from 'zod';
import { toJsonSchema } from '../schemas/json-schema.js';
import { retry, type RetryOptions } from './retry.js';
import type { ApiCallMeta, UsageTracker } from './usage.js';

/**
 * Enveloppe minimale du SDK `@google/genai` pour le pipeline : upload de rush, génération JSON
 * contrainte par un schéma Zod, génération d'images. Chaque appel passe par `UsageTracker`.
 * Le SDK est injecté sous forme structurelle (`GeminiSdk`) pour être remplacé dans les tests.
 */

export interface GeminiFile {
  name?: string | undefined;
  uri?: string | undefined;
  mimeType?: string | undefined;
  state?: string | undefined;
  error?: { message?: string | undefined } | undefined;
}

export interface GeminiPart {
  text?: string | undefined;
  fileData?: { fileUri?: string | undefined; mimeType?: string | undefined } | undefined;
  inlineData?: { data?: string | undefined; mimeType?: string | undefined } | undefined;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number | undefined;
  candidatesTokenCount?: number | undefined;
  thoughtsTokenCount?: number | undefined;
}

export interface GeminiResponse {
  text?: string | undefined;
  candidates?: { content?: { parts?: GeminiPart[] | undefined } | undefined }[] | undefined;
  usageMetadata?: GeminiUsageMetadata | undefined;
}

export interface GeminiGenerateParams {
  model: string;
  contents: { role: 'user'; parts: GeminiPart[] };
  config?: {
    responseMimeType?: string;
    responseJsonSchema?: unknown;
    responseModalities?: string[];
    imageConfig?: { aspectRatio?: string; imageSize?: string };
    temperature?: number;
  };
}

/** Sous-ensemble structurel de `GoogleGenAI` utilisé ici. */
export interface GeminiSdk {
  files: {
    upload(params: {
      file: string;
      config?: { mimeType?: string; displayName?: string };
    }): Promise<GeminiFile>;
    get(params: { name: string }): Promise<GeminiFile>;
  };
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiResponse>;
  };
}

export class GeminiOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'GeminiOutputError';
  }
}

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
};

export function videoMimeType(file: string): string {
  const mime = VIDEO_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`format vidéo non pris en charge : ${path.basename(file)}`);
  return mime;
}

export function usageFromMetadata(meta: GeminiUsageMetadata | undefined) {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
}

export interface GeminiProviderOptions {
  /** Intervalle entre deux `files.get` pendant le traitement (défaut 3 s) */
  pollIntervalMs?: number;
  /** Délai max d'attente de l'état ACTIVE (défaut 10 min) */
  uploadTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Nouvelles tentatives sur 429/503/5xx (défaut : 5 tentatives, 2 s → 30 s) */
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'onRetry'>;
}

export class GeminiProvider {
  private readonly pollIntervalMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly sdk: GeminiSdk,
    private readonly tracker: UsageTracker,
    options: GeminiProviderOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 10 * 60 * 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryOptions = { ...options.retry, sleep: this.sleep };
  }

  /** Appel SDK avec nouvelles tentatives sur erreur passagère (surcharge, quota, réseau). */
  private generate(params: GeminiGenerateParams): Promise<GeminiResponse> {
    return retry(() => this.sdk.models.generateContent(params), this.retryOptions);
  }

  /** Envoie un fichier via la Files API et attend qu'il soit exploitable (état ACTIVE). */
  async uploadFile(
    file: string,
    mimeType: string,
  ): Promise<{ uri: string; mimeType: string; name: string }> {
    let f = await retry(
      () => this.sdk.files.upload({ file, config: { mimeType, displayName: path.basename(file) } }),
      this.retryOptions,
    );
    const deadline = Date.now() + this.uploadTimeoutMs;
    while (f.state === 'PROCESSING') {
      if (Date.now() > deadline)
        throw new Error(`upload Gemini : délai dépassé pour ${path.basename(file)}`);
      await this.sleep(this.pollIntervalMs);
      if (!f.name) throw new Error('upload Gemini : réponse sans nom de fichier');
      f = await this.sdk.files.get({ name: f.name });
    }
    if (f.state !== 'ACTIVE' || !f.uri) {
      throw new Error(
        `upload Gemini : fichier ${f.state ?? 'inconnu'} — ${f.error?.message ?? 'sans détail'}`,
      );
    }
    return { uri: f.uri, mimeType: f.mimeType ?? mimeType, name: f.name ?? '' };
  }

  /** Génération JSON contrainte par un schéma Zod, validée côté client. */
  async generateJson<T>(params: {
    model: string;
    schema: z.ZodType<T>;
    parts: GeminiPart[];
    meta: ApiCallMeta;
    temperature?: number;
  }): Promise<{ data: T; raw: string; usage: ReturnType<typeof usageFromMetadata> }> {
    return this.tracker.track(params.meta, async () => {
      const config: NonNullable<GeminiGenerateParams['config']> = {
        responseMimeType: 'application/json',
        responseJsonSchema: toJsonSchema(params.schema),
      };
      if (params.temperature !== undefined) config.temperature = params.temperature;
      const res = await this.generate({
        model: params.model,
        contents: { role: 'user', parts: params.parts },
        config,
      });
      const usage = usageFromMetadata(res.usageMetadata);
      const raw = res.text ?? '';
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new GeminiOutputError('réponse Gemini non JSON', raw);
      }
      const parsed = params.schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' ; ');
        throw new GeminiOutputError(`réponse Gemini hors schéma : ${issues}`, raw);
      }
      return { result: { data: parsed.data, raw, usage }, usage };
    });
  }

  /** Génération d'images ; renvoie les PNG/JPEG décodés. */
  async generateImages(params: {
    model: string;
    prompt: string;
    meta: ApiCallMeta;
    aspectRatio?: string;
    imageSize?: string;
  }): Promise<{ images: { data: Buffer; mimeType: string }[]; text: string }> {
    return this.tracker.track(params.meta, async () => {
      const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
      if (params.aspectRatio) imageConfig.aspectRatio = params.aspectRatio;
      if (params.imageSize) imageConfig.imageSize = params.imageSize;
      const res = await this.generate({
        model: params.model,
        contents: { role: 'user', parts: [{ text: params.prompt }] },
        config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig },
      });
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const images = parts
        .filter(
          (p): p is GeminiPart & { inlineData: { data: string; mimeType?: string } } =>
            typeof p.inlineData?.data === 'string',
        )
        .map((p) => ({
          data: Buffer.from(p.inlineData.data, 'base64'),
          mimeType: p.inlineData.mimeType ?? 'image/png',
        }));
      const text = parts
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      if (images.length === 0) throw new GeminiOutputError('aucune image dans la réponse', text);
      const tokenUsage = usageFromMetadata(res.usageMetadata);
      return { result: { images, text }, usage: { ...tokenUsage, images: images.length } };
    });
  }
}
