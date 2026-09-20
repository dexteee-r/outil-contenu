import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Tarif d'un modèle, en USD (les API facturent en USD). */
export const pricingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tokens'),
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('image'), perImage: z.number().nonnegative() }).strict(),
]);
export type Pricing = z.infer<typeof pricingSchema>;
export type PricingTable = Record<string, Pricing>;

/**
 * Grille par défaut. Les modèles Gemini Flash n'y sont pas tant que leur ID et leur tarif
 * ne sont pas confirmés (spike S1) : un modèle absent donne un coût `null`, jamais 0.
 * Surcharge possible via `pricing.json` à la racine du repo.
 */
export const DEFAULT_PRICING: PricingTable = {
  'claude-sonnet-5': { kind: 'tokens', inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5': { kind: 'tokens', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-haiku-4-5': { kind: 'tokens', inputPerMTok: 1, outputPerMTok: 5 },
  'gemini-3-pro-image': { kind: 'image', perImage: 0.035 },
};

export const PRICING_FILE = 'pricing.json';

/** Grille par défaut + surcharge éventuelle de `<repoRoot>/pricing.json`. */
export function loadPricing(repoRoot: string): PricingTable {
  const file = path.join(repoRoot, PRICING_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_PRICING };
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = z.record(z.string(), pricingSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`${PRICING_FILE} invalide :\n${issues}`);
  }
  return { ...DEFAULT_PRICING, ...parsed.data };
}

export interface ApiUsage {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
}

/** Coût estimé en USD, ou `null` si le modèle n'est pas dans la grille. */
export function estimateCostUsd(
  model: string,
  usage: ApiUsage,
  pricing: PricingTable,
): number | null {
  const p = pricing[model];
  if (!p) return null;
  switch (p.kind) {
    case 'tokens':
      return (
        ((usage.inputTokens ?? 0) * p.inputPerMTok + (usage.outputTokens ?? 0) * p.outputPerMTok) /
        1_000_000
      );
    case 'image':
      return (usage.images ?? 0) * p.perImage;
  }
}
