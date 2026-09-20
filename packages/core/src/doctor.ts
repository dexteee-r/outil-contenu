/**
 * Vérifications de prérequis (`pnpm doctor`) : le PC a-t-il tout ce qu'il faut ?
 * Renvoie une liste de contrôles ; `fail` bloque, `warn` signale, `info` renseigne.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AccountConfigError, listAccounts, loadAccount } from './config/account.js';
import { findRepoRoot, loadEnv } from './env.js';
import { accountsDir, dataPaths } from './paths.js';

export type DoctorLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  level: DoctorLevel;
  label: string;
  detail?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Commande constante (pas d'entrée utilisateur) : le shell est nécessaire sur Windows pour les .cmd
function firstLine(command: string): string | null {
  try {
    const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function runDoctor(options: { repoRoot?: string } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (level: DoctorLevel, label: string, detail?: string) => {
    checks.push(detail === undefined ? { level, label } : { level, label, detail });
  };
  const tool = (command: string, label: string, hint: string) => {
    const v = firstLine(command);
    if (v) add('ok', label, v);
    else add('fail', label, `introuvable dans le PATH — ${hint}`);
  };

  // --- Runtime ---------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  add(
    major >= 22 ? 'ok' : 'fail',
    'Node.js',
    `v${process.versions.node}${major >= 22 ? '' : ' — Node 22 ou plus requis'}`,
  );
  tool('pnpm --version', 'pnpm', 'npm install -g pnpm');
  tool('git --version', 'git', 'https://git-scm.com/download/win');

  // --- Vidéo -----------------------------------------------------------------
  tool('ffmpeg -version', 'ffmpeg', 'winget install Gyan.FFmpeg puis rouvrir le terminal');
  tool('ffprobe -version', 'ffprobe', 'fourni avec ffmpeg');

  // --- Binaires natifs Node ---------------------------------------------------
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    const row = db.prepare('select sqlite_version() as v').get() as { v: string };
    db.close();
    add('ok', 'better-sqlite3', `SQLite ${row.v}`);
  } catch (err) {
    add(
      'fail',
      'better-sqlite3',
      `binaire natif non chargé — pnpm rebuild better-sqlite3 (${errorMessage(err)})`,
    );
  }

  try {
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } })
      .png()
      .toBuffer();
    add(png.length > 0 ? 'ok' : 'fail', 'sharp', `libvips ${sharp.versions.vips}`);
  } catch (err) {
    add('fail', 'sharp', `binaire natif non chargé — pnpm rebuild sharp (${errorMessage(err)})`);
  }

  add(
    'info',
    'Remotion / Chrome headless',
    'pas encore installé — arrive avec packages/video (spike S2)',
  );

  // --- Config ----------------------------------------------------------------
  const repoRoot = options.repoRoot ?? findRepoRoot();
  if (!fs.existsSync(path.join(repoRoot, '.env'))) {
    add('warn', '.env', 'absent — copier .env.example en .env et remplir');
  }

  try {
    const env = loadEnv({ repoRoot });
    const paths = dataPaths(env, repoRoot);
    const rootExists = fs.existsSync(paths.root);
    add(
      rootExists ? 'ok' : 'warn',
      'DATA_ROOT',
      `${paths.root}${rootExists ? '' : ' — sera créé au premier run'}`,
    );
    add(
      env.GEMINI_API_KEY ? 'ok' : 'warn',
      'GEMINI_API_KEY',
      env.GEMINI_API_KEY ? 'définie' : 'manquante (nécessaire dès le spike S1)',
    );
    add(
      env.ANTHROPIC_API_KEY ? 'ok' : 'warn',
      'ANTHROPIC_API_KEY',
      env.ANTHROPIC_API_KEY ? 'définie' : 'manquante (nécessaire dès l’étape 3)',
    );
    add(
      'info',
      'Modèles',
      `tagging=${env.MODEL_TAGGING ?? '?'} · image=${env.MODEL_IMAGE ?? '?'} · edl=${env.MODEL_EDL} · captions=${env.MODEL_CAPTIONS}`,
    );

    const dir = accountsDir(env, repoRoot);
    const slugs = listAccounts(dir);
    if (slugs.length === 0) add('fail', 'Comptes', `aucun account.yaml dans ${dir}`);
    for (const slug of slugs) {
      try {
        const loaded = loadAccount(slug, dir);
        add(
          loaded.warnings.length ? 'warn' : 'ok',
          `Compte ${slug}`,
          loaded.warnings.length ? loaded.warnings.join(' ; ') : loaded.config.displayName,
        );
      } catch (err) {
        add(
          'fail',
          `Compte ${slug}`,
          err instanceof AccountConfigError ? err.issues.join(' ; ') : errorMessage(err),
        );
      }
    }
  } catch (err) {
    add('fail', '.env', errorMessage(err));
  }

  return checks;
}

export const DOCTOR_ICON: Record<DoctorLevel, string> = {
  ok: '✔',
  warn: '⚠',
  fail: '✖',
  info: '·',
};

export function formatDoctorReport(checks: DoctorCheck[]): {
  lines: string[];
  fails: number;
  warns: number;
} {
  const lines = checks.map(
    (c) => `${DOCTOR_ICON[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
  );
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push('');
  lines.push(
    fails
      ? `${fails} problème(s) bloquant(s), ${warns} avertissement(s).`
      : `Tout est prêt (${warns} avertissement(s)).`,
  );
  return { lines, fails, warns };
}
