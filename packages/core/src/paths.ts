import path from 'node:path';
import type { Env } from './env.js';

/**
 * Arborescence du cahier des charges, ancrée sur DATA_ROOT :
 *   <DATA_ROOT>/raw/<compte>/<date>/       rushs et briefs déposés
 *   <DATA_ROOT>/processing/<content-id>/   en cours de traitement
 *   <DATA_ROOT>/ready/<compte>/<content-id>/  livrables + metadata.json
 * Aucun chemin Unix en dur : tout passe par path.join pour rester portable Windows/Linux.
 */
export interface DataPaths {
  root: string;
  db: string;
  raw: (account?: string, date?: string) => string;
  processing: (contentId?: string) => string;
  ready: (account?: string, contentId?: string) => string;
}

export function dataPaths(env: Env, repoRoot: string): DataPaths {
  const root = path.resolve(repoRoot, env.DATA_ROOT);
  const join = (...parts: (string | undefined)[]) =>
    path.join(root, ...parts.filter((p): p is string => p !== undefined));
  return {
    root,
    db: env.DB_PATH ? path.resolve(repoRoot, env.DB_PATH) : join('outil.sqlite'),
    raw: (account, date) => join('raw', account, date),
    processing: (contentId) => join('processing', contentId),
    ready: (account, contentId) => join('ready', account, contentId),
  };
}

export function accountsDir(env: Env, repoRoot: string): string {
  return path.resolve(repoRoot, env.ACCOUNTS_DIR ?? 'accounts');
}
