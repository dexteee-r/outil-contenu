import { z } from 'zod';

export type JsonSchemaTarget = 'draft-2020-12' | 'openapi-3.0';

/**
 * JSON Schema d'un contrat Zod, à donner aux modèles :
 * - Claude : passer directement le schéma Zod à `zodOutputFormat()` du SDK (qui retire lui-même
 *   les contraintes non supportées et les vérifie côté client) ; ce helper sert aux tests
 *   et à l'inspection.
 * - Gemini : `responseJsonSchema` (draft 2020-12) ou `responseSchema` (cible `openapi-3.0`).
 */
export function toJsonSchema(
  schema: z.ZodType,
  options: { target?: JsonSchemaTarget } = {},
): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, {
    target: options.target ?? 'draft-2020-12',
    unrepresentable: 'any',
  });
  return rest;
}
