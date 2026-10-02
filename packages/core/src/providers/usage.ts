import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiCalls, type ApiModule, type ApiProvider } from '../db/schema.js';
import type { AccountConfig } from '../config/account.js';
import { estimateCostUsd, type ApiUsage, type PricingTable } from './pricing.js';

export type Budget = AccountConfig['budget'];

/** Plafond strict atteint : la génération est refusée avant tout appel payant. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly account: string,
    public readonly spentEur: number,
    public readonly limitEur: number,
  ) {
    super(
      `plafond budgétaire du compte ${account} atteint : ${spentEur.toFixed(2)} € dépensés ce mois-ci ` +
        `pour ${limitEur.toFixed(2)} € — nouvelles générations suspendues jusqu'au mois prochain ` +
        `(ou relever budget.monthlyLimitEur dans account.yaml)`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Franchissement d'un seuil ou d'un plafond (une fois, au moment où la dépense le dépasse). */
export interface BudgetAlert {
  account: string;
  mode: 'threshold' | 'cap';
  spentEur: number;
  limitEur: number;
}

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
  /** Budget du compte, relu à chaque appel (un plafond relevé dans account.yaml compte tout de suite) */
  budgetOf?: (account: string) => Budget | undefined;
  /** Seuil ou plafond franchi par le dernier appel */
  onBudgetAlert?: (alert: BudgetAlert) => void;
  now?: () => Date;
}

/**
 * Enveloppe chaque appel API : mesure la durée, calcule le coût depuis l'usage renvoyé,
 * écrit une ligne dans `api_calls` — y compris en cas d'erreur, pour que l'historique
 * de facturation et le garde-fou budgétaire voient tout.
 */
export class UsageTracker {
  private readonly warned = new Set<string>();
  private readonly admitted = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly options: UsageTrackerOptions,
  ) {}

  /** Dépense du mois et budget du compte. */
  budgetStatus(account: string): {
    budget: Budget;
    spentEur: number;
    limitEur: number | null;
    capReached: boolean;
  } {
    const budget = this.options.budgetOf?.(account) ?? { mode: 'unlimited' as const };
    const spentEur = spendSince(this.db, startOfMonthIso(this.now()), { account });
    const limitEur = budget.mode === 'unlimited' ? null : budget.monthlyLimitEur;
    return {
      budget,
      spentEur,
      limitEur,
      capReached: budget.mode === 'cap' && spentEur >= budget.monthlyLimitEur,
    };
  }

  /** Avant une nouvelle génération : lève BudgetExceededError si le plafond strict est atteint. */
  assertBudget(account: string): void {
    const s = this.budgetStatus(account);
    if (s.capReached) throw new BudgetExceededError(account, s.spentEur, s.limitEur!);
  }

  /**
   * Contenu commencé sous le plafond : ses appels passent même si le plafond est atteint en
   * route (un contenu en cours se termine) ; `release` à la fin.
   */
  admit(contentId: string): void {
    this.admitted.add(contentId);
  }

  release(contentId: string): void {
    this.admitted.delete(contentId);
  }

  async track<T>(meta: ApiCallMeta, call: () => Promise<TrackedResult<T>>): Promise<T> {
    // Contrôle avant chaque appel payant, sauf pour un contenu admis (déjà en cours)
    if (meta.account && !(meta.contentId && this.admitted.has(meta.contentId))) {
      this.assertBudget(meta.account);
    }
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
    const before = meta.account && costUsd ? this.budgetStatus(meta.account) : null;
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
    // Alerte une seule fois : quand cet appel fait passer la dépense au-dessus de la limite
    if (before && before.limitEur !== null && before.budget.mode !== 'unlimited') {
      const spentEur = before.spentEur + costUsd! * this.options.usdEurRate;
      if (before.spentEur < before.limitEur && spentEur >= before.limitEur) {
        this.options.onBudgetAlert?.({
          account: meta.account!,
          mode: before.budget.mode,
          spentEur,
          limitEur: before.limitEur,
        });
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
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
