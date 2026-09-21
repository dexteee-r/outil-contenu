import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { retry, type RetryOptions } from './retry.js';
import type { ApiCallMeta, UsageTracker } from './usage.js';

/**
 * Enveloppe minimale du SDK Anthropic pour le pipeline : génération structurée (EDL, légendes)
 * validée par un schéma Zod via `messages.parse` + `zodOutputFormat`. SDK injecté sous forme
 * structurelle pour les tests ; chaque appel passe par `UsageTracker`.
 */

export type AnthropicMessage = { role: 'user' | 'assistant'; content: string };

export interface AnthropicParseParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  output_config: { format: unknown; effort?: 'low' | 'medium' | 'high' };
  thinking?: { type: 'adaptive' };
}

export interface AnthropicParsedMessage {
  parsed_output: unknown;
  stop_reason?: string | null | undefined;
  usage?: { input_tokens?: number | undefined; output_tokens?: number | undefined } | undefined;
  content?: { type: string; text?: string | undefined }[] | undefined;
}

/** Sous-ensemble structurel du client `Anthropic` utilisé ici. */
export interface AnthropicSdk {
  messages: { parse(params: AnthropicParseParams): Promise<AnthropicParsedMessage> };
}

export class AnthropicOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'AnthropicOutputError';
  }
}

export interface AnthropicProviderOptions {
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'onRetry'>;
  sleep?: (ms: number) => Promise<void>;
}

export interface StructuredResult<T> {
  data: T;
  /** Texte brut renvoyé (pour les journaux et le renvoi de corrections) */
  raw: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class AnthropicProvider {
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly sdk: AnthropicSdk,
    private readonly tracker: UsageTracker,
    options: AnthropicProviderOptions = {},
  ) {
    this.retryOptions = { ...options.retry, ...(options.sleep ? { sleep: options.sleep } : {}) };
  }

  /**
   * Génération contrainte par un schéma Zod. `messages` porte l'historique complet (la boucle de
   * correction ajoute la réponse précédente et la liste des problèmes en tours suivants).
   */
  async generateStructured<T>(params: {
    model: string;
    schema: z.ZodType<T>;
    system: string;
    messages: AnthropicMessage[];
    meta: ApiCallMeta;
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<StructuredResult<T>> {
    return this.tracker.track(params.meta, async () => {
      const request: AnthropicParseParams = {
        model: params.model,
        max_tokens: params.maxTokens ?? 16000,
        system: params.system,
        messages: params.messages,
        output_config: {
          format: zodOutputFormat(params.schema),
          effort: params.effort ?? 'medium',
        },
        thinking: { type: 'adaptive' },
      };
      const res = await retry(() => this.sdk.messages.parse(request), this.retryOptions);
      const usage = {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      };
      const raw = (res.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (res.stop_reason === 'max_tokens') {
        throw new AnthropicOutputError('réponse Claude tronquée (max_tokens)', raw);
      }
      if (res.stop_reason === 'refusal') {
        throw new AnthropicOutputError('Claude a refusé la demande', raw);
      }
      // parsed_output est déjà validé par le SDK ; on repasse par le schéma pour le typage strict
      const parsed = params.schema.safeParse(res.parsed_output);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' ; ');
        throw new AnthropicOutputError(`réponse Claude hors schéma : ${issues}`, raw);
      }
      return { result: { data: parsed.data, raw, usage }, usage };
    });
  }
}
