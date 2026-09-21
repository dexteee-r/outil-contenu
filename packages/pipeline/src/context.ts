import {
  createAnthropicProvider,
  createGeminiProvider,
  createKieProvider,
  createUsageTracker,
  type AnthropicProvider,
  type AppContext,
  type Db,
  type GeminiProvider,
  type KieProvider,
  type UsageTracker,
} from '@outil/core';

/** Journal du pipeline : une ligne par événement, préfixée par le contenu et l'étape. */
export type PipelineLogger = (message: string) => void;

/**
 * Tout ce dont les étapes ont besoin. Les fournisseurs sont créés à la demande : une clé absente
 * ne bloque que l'étape qui en dépend, avec un message clair.
 */
export interface PipelineContext {
  ctx: AppContext;
  db: Db;
  tracker: UsageTracker;
  log: PipelineLogger;
  gemini(): GeminiProvider;
  anthropic(): AnthropicProvider;
  kie(): KieProvider | null;
}

export function createPipelineContext(
  ctx: AppContext,
  db: Db,
  log: PipelineLogger = (m) => console.log(m),
): PipelineContext {
  const tracker = createUsageTracker(ctx, db, (model) =>
    log(`⚠ modèle ${model} absent de la grille tarifaire : coût enregistré à null`),
  );
  let gemini: GeminiProvider | undefined;
  let anthropic: AnthropicProvider | undefined;
  let kie: KieProvider | null | undefined;
  return {
    ctx,
    db,
    tracker,
    log,
    gemini: () => (gemini ??= createGeminiProvider(ctx, tracker)),
    anthropic: () => (anthropic ??= createAnthropicProvider(ctx, tracker)),
    kie: () => {
      if (kie === undefined) {
        kie =
          ctx.env.IMAGE_PROVIDER === 'kie' && ctx.env.KIE_API_KEY
            ? createKieProvider(ctx, tracker)
            : null;
      }
      return kie;
    },
  };
}
