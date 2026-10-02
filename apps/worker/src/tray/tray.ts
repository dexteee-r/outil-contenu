import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildAppIcon, buildTrayIcons, type PipelineStep, type TrayState } from '@outil/core';

/**
 * Icône de la zone de notification : un script PowerShell (WinForms, présent sur tout Windows)
 * lancé en processus enfant, piloté en JSON ligne par ligne. Toute la logique reste ici, côté
 * Node ; le script ne fait qu'afficher et renvoyer les clics. Il remplace systray2 retenu au spike
 * S4 : il affiche aussi les notifications Windows (toasts), sans binaire tiers à embarquer.
 */

const SCRIPT = fileURLToPath(new URL('./tray.ps1', import.meta.url));

/** Icônes générées (non versionnées) : une par état, plus celle du raccourci. */
export const ICON_DIR = fileURLToPath(new URL('../../assets/icons', import.meta.url));

export async function writeIcons(dir: string = ICON_DIR): Promise<string[]> {
  const states = await buildTrayIcons(dir);
  return [...Object.values(states), await buildAppIcon(dir)];
}

export const TRAY_COMMANDS = ['dashboard', 'ready', 'scan', 'pause', 'log', 'quit'] as const;
export type TrayCommand = (typeof TRAY_COMMANDS)[number];

export const TRAY_LABELS: Record<Exclude<TrayCommand, 'pause' | 'quit'>, string> = {
  dashboard: 'Ouvrir le tableau de bord',
  ready: 'Ouvrir le dossier des contenus prêts',
  scan: 'Traiter maintenant les dossiers en attente',
  log: 'Ouvrir le journal',
};

const STEP_LABELS: Record<PipelineStep, string> = {
  ingest: 'import',
  tag: 'dérushage',
  edl: 'montage',
  render: 'rendu',
  captions: 'légendes',
  thumbnail: 'miniatures',
  qc: 'contrôle',
  deliver: 'livraison',
  notify: 'notification',
};

/** Ce que l'icône affiche, recalculé chaque seconde. */
export interface TrayView {
  icon: TrayState;
  /** Info-bulle au survol (63 caractères au plus) */
  tooltip: string;
  /** Première ligne du menu */
  status: string;
  pauseLabel: string;
  canPause: boolean;
  canScan: boolean;
  quitLabel: string;
}

export interface TrayInput {
  /** Travail en cours (libellé de la file) et étape du pipeline */
  current: { label: string; step: PipelineStep | null } | null;
  waiting: number;
  /** Dossiers de /raw déposés, en attente de la période de calme */
  pendingFolders: number;
  watching: boolean;
  paused: boolean;
  stopping: boolean;
  /** Dernier contenu en échec, tant qu'aucun contenu n'a abouti depuis */
  lastFailure: string | null;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

export function trayView(s: TrayInput): TrayView {
  let icon: TrayState;
  let status: string;
  let short: string;
  if (s.stopping) {
    icon = 'running';
    status = s.current
      ? 'Arrêt en cours : l’étape en cours se termine…'
      : 'Arrêt en cours, sauvegarde…';
    short = 'arrêt en cours';
  } else if (s.current) {
    icon = 'running';
    const step = s.current.step ? ` — ${STEP_LABELS[s.current.step]}` : '';
    const queued = s.waiting > 0 ? ` (+${s.waiting} en file)` : '';
    status = `En cours : ${s.current.label}${step}${queued}`;
    short = s.current.step ? `${STEP_LABELS[s.current.step]} en cours` : 'traitement en cours';
  } else if (s.lastFailure) {
    icon = 'error';
    status = `Échec : ${s.lastFailure} — voir le tableau de bord`;
    short = `échec de ${s.lastFailure}`;
  } else if (!s.watching) {
    icon = 'idle';
    status = 'Surveillance de /raw désactivée';
    short = 'tableau de bord seul';
  } else if (s.paused) {
    icon = 'paused';
    status = 'Surveillance en pause';
    short = 'surveillance en pause';
  } else if (s.pendingFolders > 0) {
    icon = 'idle';
    status = `${plural(s.pendingFolders, 'dossier')} en attente de la période de calme`;
    short = status.toLowerCase();
  } else {
    icon = 'idle';
    status = 'En attente de rushs';
    short = 'en attente de rushs';
  }
  return {
    icon,
    tooltip: clip(`Outil contenu — ${short}`, 63),
    status: clip(status, 120),
    pauseLabel: s.paused ? 'Reprendre la surveillance' : 'Mettre en pause la surveillance',
    canPause: s.watching && !s.stopping,
    canScan: s.watching && !s.stopping && s.pendingFolders > 0,
    quitLabel: s.stopping ? 'Forcer l’arrêt (le contenu sera repris)' : 'Quitter',
  };
}

export interface Toast {
  title: string;
  text: string;
  error?: boolean;
}

export interface Tray {
  update(view: TrayView): void;
  toast(t: Toast): void;
  /** Retire l'icône et attend la fin du processus (tué au bout de 5 s s'il ne répond pas) */
  close(): Promise<void>;
}

export interface TrayOptions {
  onCommand: (cmd: TrayCommand) => void;
  /** Le processus de l'icône s'est terminé sans qu'on le lui demande */
  onLost: (reason: string) => void;
  log: (m: string) => void;
  iconDir?: string;
  spawnImpl?: (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;
}

const defaultSpawn = (cmd: string, args: string[]) =>
  spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

export function startTray(o: TrayOptions): Tray {
  const child = (o.spawnImpl ?? defaultSpawn)('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    SCRIPT,
    '-IconDir',
    o.iconDir ?? ICON_DIR,
  ]);
  let closing = false;
  let exited = false;
  let lastView = '';
  const done = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      if (!closing) o.onLost(`processus de l’icône terminé (code ${code ?? '?'})`);
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      if (!closing) o.onLost(`icône impossible à lancer (${err.message})`);
      resolve();
    });
  });
  // Une icône fermée entre deux messages : l'écriture échoue, sans conséquence
  child.stdin.on('error', () => undefined);

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const { cmd } = JSON.parse(line) as { cmd?: unknown };
      if (TRAY_COMMANDS.includes(cmd as TrayCommand)) o.onCommand(cmd as TrayCommand);
    } catch {
      o.log(`tray : message illisible ignoré (${clip(line, 80)})`);
    }
  });
  readline
    .createInterface({ input: child.stderr })
    .on('line', (line) => line.trim() && o.log(`tray : ${clip(line.trim(), 300)}`));

  const send = (message: unknown) => {
    if (exited || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  send({ type: 'init', labels: TRAY_LABELS });

  return {
    update(view) {
      const json = JSON.stringify(view);
      if (json === lastView) return;
      lastView = json;
      send({ type: 'state', ...view });
    },
    toast(t) {
      send({ type: 'toast', title: t.title, text: t.text, error: t.error ?? false });
    },
    async close() {
      if (exited) return;
      closing = true;
      send({ type: 'exit' });
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      await done;
      clearTimeout(timer);
    },
  };
}
