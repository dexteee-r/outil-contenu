import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiCalls, type ApiModule, type ApiProvider } from '../db/schema.js';
import { estimateCostUsd, type ApiUsage, type PricingTable } from './pricing.js';

export interface ApiCallMeta {
  module: ApiModule;
  provider: ApiProvider;
  model: string;
  account?: string;
  contentId?: string;
  jobId?: number;
}

export interface TrackedResult<T> {
  result: T;
  usage: ApiUsage;
  /** Coût exact fourni par le fournisseur (ex. crédits kie.ai) : prime sur la grille tarifaire */
  costUsd?: number;
}

export interface UsageTrackerOptions {
  pricing: PricingTable;
  usdEurRate: number;
  /** Appelé quand un modèle n'est pas dans la grille tarifaire (coût enregistré à null). */
  onUnknownModel?: (model: string) => void;
}

/**
 * Enveloppe chaque appel API : mesure la durée, calcule le coût depuis l'usage renvoyé,
 * écrit une ligne dans `api_calls` — y compris en cas d'erreur, pour que l'historique
 * de facturation et le garde-fou budgétaire voient tout.
 */
export class UsageTracker {
  private readonly warned = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly options: UsageTrackerOptions,
  ) {}

  async track<T>(meta: ApiCallMeta, call: () => Promise<TrackedResult<T>>): Promise<T> {
    const started = performance.now();
    try {
      const { result, usage, costUsd } = await call();
      this.record(meta, usage, Math.round(performance.now() - started), null, costUsd);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record(meta, {}, Math.round(performance.now() - started), message);
      throw err;
    }
  }

  /** Enregistre un appel déjà effectué (utile quand l'usage est connu après coup). */
  record(
    meta: ApiCallMeta,
    usage: ApiUsage,
    durationMs: number,
    error: string | null,
    exactCostUsd?: number,
  ): void {
    const costUsd = exactCostUsd ?? estimateCostUsd(meta.model, usage, this.options.pricing);
    // Avertir seulement si le coût est inconnu ET que le fournisseur ne l'a pas donné (ex. kie.ai le donne)
    if (costUsd === null && exactCostUsd === undefined && !this.warned.has(meta.model)) {
      this.warned.add(meta.model);
      this.options.onUnknownModel?.(meta.model);
    }
    this.db
      .insert(apiCalls)
      .values({
        module: meta.module,
        provider: meta.provider,
        model: meta.model,
        account: meta.account ?? null,
        contentId: meta.contentId ?? null,
        jobId: meta.jobId ?? null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        images: usage.images ?? null,
        costUsd,
        costEur: costUsd === null ? null : costUsd * this.options.usdEurRate,
        durationMs,
        status: error === null ? 'ok' : 'error',
        error,
      })
      .run();
  }
}

export interface SpendFilter {
  account?: string;
  module?: ApiModule;
}

/** Dépense en EUR depuis `sinceIso` (appels au coût inconnu ignorés). Base du garde-fou budgétaire. */
export function spendSince(db: Db, sinceIso: string, filter: SpendFilter = {}): number {
  const conditions = [gte(apiCalls.at, sinceIso)];
  if (filter.account) conditions.push(eq(apiCalls.account, filter.account));
  if (filter.module) conditions.push(eq(apiCalls.module, filter.module));
  const row = db
    .select({ total: sql<number>`coalesce(sum(${apiCalls.costEur}), 0)` })
    .from(apiCalls)
    .where(and(...conditions))
    .get();
  return row?.total ?? 0;
}

/** Premier jour du mois courant, en ISO, pour `spendSince`. */
export function startOfMonthIso(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}
