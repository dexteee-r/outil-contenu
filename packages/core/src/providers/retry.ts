/**
 * Nouvelles tentatives avec attente exponentielle pour les erreurs passagères des API
 * (429 quota, 503 surcharge, 5xx). Les erreurs de contrat (400, JSON hors schéma) ne sont
 * jamais rejouées ici : elles se traitent en renvoyant le problème au modèle.
 */

export interface RetryOptions {
  /** Nombre total de tentatives (défaut 5) */
  attempts?: number;
  /** Attente avant la 2e tentative (défaut 2 s), doublée à chaque fois */
  baseDelayMs?: number;
  /** Plafond d'attente entre deux tentatives (défaut 30 s) */
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Erreur passagère d'API (statut HTTP ou message Google « UNAVAILABLE » / « RESOURCE_EXHAUSTED »). */
export function isTransientApiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : undefined;
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    message,
  );
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // attempt 1 → base, 2 → 2×base, … avec un peu d'aléa pour ne pas retenter tous en même temps
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const isRetryable = options.isRetryable ?? isTransientApiError;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}
