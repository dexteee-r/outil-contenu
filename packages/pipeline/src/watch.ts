import fs from 'node:fs';
import path from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  BudgetExceededError,
  contents,
  isTransientApiError,
  jobs,
  listAccounts,
} from '@outil/core';
import type { PipelineContext } from './context.js';
import { isVideoFile } from './ids.js';
import { notifyBudget, notifyDisk, notifyFailed } from './notify.js';
import { JobQueue } from './queue.js';
import { InterruptedError, resumeContent, runContent, type RunOptions } from './runner.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Attente avant de retenter un contenu en échec pour une panne passagère (Gemini 503, Claude surchargé, réseau). */
export const AUTO_RETRY_DELAY_MS = 30 * 60_000;
/** Échecs passagers d'affilée au-delà desquels on laisse la main (« Reprendre » dans le tableau de bord). */
export const AUTO_RETRY_MAX = 3;

/**
 * Contenus à retenter : en échec, dernière erreur passagère (pas un quota du jour, pas une erreur
 * de contrat), moins de AUTO_RETRY_MAX échecs depuis le dernier succès, échec vieux d'au moins
 * AUTO_RETRY_DELAY_MS.
 */
export function autoRetryCandidates(
  p: PipelineContext,
  nowMs: number,
): { contentId: string; failures: number }[] {
  const failed = p.db
    .select({ id: contents.id })
    .from(contents)
    .where(eq(contents.status, 'failed'))
    .all();
  const out: { contentId: string; failures: number }[] = [];
  for (const { id } of failed) {
    const history = p.db
      .select()
      .from(jobs)
      .where(eq(jobs.contentId, id))
      .orderBy(desc(jobs.id))
      .all();
    const last = history[0];
    if (!last || last.status !== 'failed' || !last.error || !last.finishedAt) continue;
    if (!isTransientApiError({ message: last.error })) continue;
    if (nowMs - Date.parse(last.finishedAt) < AUTO_RETRY_DELAY_MS) continue;
    let failures = 0;
    for (const j of history) {
      if (j.status === 'done') break;
      if (j.status === 'failed') failures++;
    }
    if (failures < AUTO_RETRY_MAX) out.push({ contentId: id, failures });
  }
  return out;
}

/**
 * Surveillance de /raw/<compte>/<dossier>/ : un dossier est traité quand son contenu n'a plus
 * bougé depuis `quietMs` (transfert Syncthing terminé), qu'il contient au moins une vidéo et aucun
 * fichier temporaire. Balayage périodique plutôt qu'événements du système de fichiers : plus fiable
 * sous Windows avec les renommages de Syncthing, et testable avec une horloge injectée.
 */

/** Fichiers temporaires de Syncthing (transfert en cours). */
export const SYNCTHING_TEMP = /^(\.syncthing\..*\.tmp|~syncthing~.*)$/i;
/** Fichiers en cours d'envoi depuis le tableau de bord (renommés une fois complets). */
export const UPLOAD_TEMP = /\.part$/i;
const isTempFile = (name: string) => SYNCTHING_TEMP.test(name) || UPLOAD_TEMP.test(name);

/** Marqueur déposé dans un dossier traité (idempotence, visible dans l'explorateur). */
export const PROCESSED_MARKER = '.processed';

export interface InboxFolder {
  account: string;
  dir: string;
  videos: string[];
  /** Transfert encore en cours (fichier temporaire Syncthing présent) */
  hasTemp: boolean;
  /** Empreinte du contenu : change dès qu'un fichier arrive, grossit ou est modifié */
  signature: string;
}

const norm = (dir: string) => {
  const abs = path.resolve(dir);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};

/** Dossiers de /raw non encore traités (ni marqueur, ni contenu en base pour ce dossier). */
export function scanInbox(p: PipelineContext): InboxFolder[] {
  const known = new Set(
    p.db
      .select({ sourceDir: contents.sourceDir })
      .from(contents)
      .all()
      .map((r) => norm(r.sourceDir)),
  );
  const folders: InboxFolder[] = [];
  for (const account of listAccounts(p.ctx.accountsDir)) {
    const root = p.ctx.paths.raw(account);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      if (fs.existsSync(path.join(dir, PROCESSED_MARKER)) || known.has(norm(dir))) continue;
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile());
      const hasTemp = files.some((f) => isTempFile(f.name));
      const videos = files.map((f) => f.name).filter((n) => isVideoFile(n) && !isTempFile(n));
      const signature = files
        .map((f) => {
          const st = fs.statSync(path.join(dir, f.name));
          return `${f.name}:${st.size}:${Math.round(st.mtimeMs)}`;
        })
        .sort()
        .join('|');
      folders.push({ account, dir, videos: videos.sort(), hasTemp, signature });
    }
  }
  return folders;
}

/** Suit l'empreinte des dossiers entre deux balayages pour détecter la période de calme. */
export class InboxTracker {
  private readonly seen = new Map<string, { signature: string; since: number }>();

  constructor(
    private readonly quietMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Dossiers prêts à traiter parmi ceux du balayage ; oublie les dossiers disparus. */
  ready(folders: InboxFolder[]): InboxFolder[] {
    const t = this.now();
    const present = new Set(folders.map((f) => f.dir));
    for (const dir of this.seen.keys()) if (!present.has(dir)) this.seen.delete(dir);
    const out: InboxFolder[] = [];
    for (const f of folders) {
      const prev = this.seen.get(f.dir);
      if (!prev || prev.signature !== f.signature) {
        this.seen.set(f.dir, { signature: f.signature, since: t });
        if (this.quietMs > 0) continue;
      }
      const since = this.seen.get(f.dir)!.since;
      if (!f.hasTemp && f.videos.length > 0 && t - since >= this.quietMs) out.push(f);
    }
    return out;
  }

  /** « Traiter maintenant » : dossiers complets, sans attendre la période de calme. */
  readyNow(folders: InboxFolder[]): InboxFolder[] {
    return folders.filter((f) => !f.hasTemp && f.videos.length > 0);
  }

  /** Oublie un dossier (après traitement). */
  forget(dir: string): void {
    this.seen.delete(dir);
  }
}

export function writeProcessedMarker(
  dir: string,
  info: { contentId: string | null; status: 'ready' | 'failed' | 'interrupted'; error?: string },
): void {
  fs.writeFileSync(
    path.join(dir, PROCESSED_MARKER),
    JSON.stringify({ ...info, at: new Date().toISOString() }, null, 2),
  );
}

export interface DiskStatus {
  freeGb: number;
  totalGb: number;
  low: boolean;
}

/** Espace libre du disque des données. */
export function checkDisk(p: PipelineContext): DiskStatus {
  const s = fs.statfsSync(p.ctx.paths.root);
  const gb = (blocks: number) => (blocks * s.bsize) / 1024 ** 3;
  const freeGb = gb(s.bavail);
  return { freeGb, totalGb: gb(s.blocks), low: freeGb < p.ctx.env.DISK_ALERT_FREE_GB };
}

export interface WatchOptions {
  /** Minutes de calme avant traitement (0 = tout de suite) */
  quietMs: number;
  /** Intervalle entre deux balayages */
  intervalMs: number;
  /** Arrêt propre : l'étape en cours se termine, puis le worker s'arrête */
  signal?: AbortSignal | undefined;
  /** Un seul passage : reprises + dossiers prêts, puis fin (« Lancer maintenant ») */
  once?: boolean | undefined;
  now?: (() => number) | undefined;
  /** Étapes de remplacement (tests) */
  run?: RunOptions['steps'];
  /** File partagée avec le tableau de bord (un traitement à la fois) */
  queue?: JobQueue | undefined;
  /** « Traiter maintenant » et dernier balayage, pour le tableau de bord */
  control?: WatchControl | undefined;
}

/**
 * Pilotage de la surveillance depuis le tableau de bord : « traiter maintenant » réveille le
 * worker et traite les dossiers présents sans attendre la période de calme.
 */
export class WatchControl {
  lastScan: { at: string; folders: InboxFolder[] } | null = null;
  /**
   * En pause : /raw est toujours balayé (le tableau de bord voit ce qui attend) mais rien n'est
   * lancé automatiquement ; « traiter maintenant » reste possible.
   */
  paused = false;
  private forced = false;
  private wake: (() => void) | null = null;

  scanNow(): void {
    this.forced = true;
    this.wake?.();
  }

  /** Vrai une seule fois après un `scanNow()`. */
  takeForced(): boolean {
    const f = this.forced;
    this.forced = false;
    return f;
  }

  /** Réservé à la boucle : fonction qui interrompt l'attente en cours. */
  setWaker(fn: (() => void) | null): void {
    this.wake = fn;
  }
}

const sleep = (ms: number, signal?: AbortSignal, control?: WatchControl) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      control?.setWaker(null);
      resolve();
    };
    const t = setTimeout(done, ms);
    control?.setWaker(done);
    signal?.addEventListener('abort', done, { once: true });
  });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Worker : au lancement, reprend les contenus interrompus (l'application n'étant ouverte qu'à la
 * demande, un arrêt en plein job est normal), vérifie le disque, puis surveille /raw et traite les
 * dossiers prêts un par un. Renvoie le nombre de contenus traités.
 */
export async function runWatcher(p: PipelineContext, o: WatchOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const runOptions: RunOptions = { signal: o.signal, ...(o.run ? { steps: o.run } : {}) };
  const queue = o.queue ?? new JobQueue();
  let processed = 0;

  // 1. Reprise des contenus coupés en route (arrêt propre ou fermeture brutale)
  const pending = p.db
    .select()
    .from(contents)
    .where(inArray(contents.status, ['processing', 'interrupted']))
    .all();
  for (const c of pending) {
    if (o.signal?.aborted) break;
    try {
      p.log(`reprise automatique de ${c.id} (${c.status})`);
      await queue.run(`reprise de ${c.id}`, () => resumeContent(p, c.id, runOptions));
      processed++;
    } catch (err) {
      if (err instanceof InterruptedError) break;
      p.log(`reprise de ${c.id} en échec : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Disque, puis balayages
  let lastDiskCheck = -Infinity;
  const diskCheck = async () => {
    if (now() - lastDiskCheck < DAY_MS) return;
    lastDiskCheck = now();
    try {
      const disk = checkDisk(p);
      p.log(`disque : ${disk.freeGb.toFixed(0)} Go libres sur ${disk.totalGb.toFixed(0)} Go`);
      if (disk.low) await notifyDisk(p, disk);
    } catch (err) {
      p.log(`disque : mesure impossible (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const tracker = new InboxTracker(o.once ? 0 : o.quietMs, now);
  let announced = new Set<string>();
  // Dossiers refusés pour cause de plafond : une seule alerte chacun
  const budgetBlocked = new Set<string>();
  for (;;) {
    if (o.signal?.aborted) break;
    await diskCheck();
    // Contenus en échec pour une panne passagère d'API : nouvel essai programmé
    for (const c of o.control?.paused ? [] : autoRetryCandidates(p, now())) {
      if (o.signal?.aborted) break;
      p.log(
        `↻ nouvel essai automatique de ${c.contentId} (panne passagère, essai ${c.failures + 1}/${AUTO_RETRY_MAX})`,
      );
      try {
        await queue.run(`nouvel essai de ${c.contentId}`, () =>
          resumeContent(p, c.contentId, runOptions),
        );
        processed++;
      } catch (err) {
        if (err instanceof InterruptedError) break;
        p.log(`nouvel essai de ${c.contentId} en échec : ${errorText(err)}`);
      }
    }
    const folders = scanInbox(p);
    if (o.control) o.control.lastScan = { at: new Date(now()).toISOString(), folders };
    // Signale une fois les dossiers qui arrivent (la période de calme commence)
    const fresh = folders.filter((f) => !announced.has(f.dir));
    for (const f of fresh) {
      p.log(
        `nouveau dossier : ${f.dir} (${f.videos.length} vidéo(s)${f.hasTemp ? ', transfert en cours' : ''})`,
      );
    }
    announced = new Set(folders.map((f) => f.dir));

    // La période de calme est suivie même en pause : à la reprise, un dossier calme part aussitôt
    const forced = o.control?.takeForced() ?? false;
    const quiet = tracker.ready(folders);
    const ready = forced ? tracker.readyNow(folders) : o.control?.paused ? [] : quiet;
    for (const f of ready) {
      if (o.signal?.aborted) break;
      tracker.forget(f.dir);
      p.log(`▶▶ traitement de ${f.dir}`);
      try {
        const state = await queue.run(`traitement de ${path.basename(f.dir)}`, () =>
          runContent(p, { accountSlug: f.account, inputDir: f.dir }, runOptions),
        );
        writeProcessedMarker(f.dir, { contentId: state.contentId, status: 'ready' });
        processed++;
      } catch (err) {
        const row = p.db
          .select()
          .from(contents)
          .where(eq(contents.sourceDir, path.resolve(f.dir)))
          .get();
        if (err instanceof InterruptedError) {
          writeProcessedMarker(f.dir, { contentId: err.contentId, status: 'interrupted' });
          break;
        }
        // Plafond atteint : pas de marqueur, le dossier attend (mois suivant ou plafond relevé)
        if (err instanceof BudgetExceededError) {
          if (!budgetBlocked.has(f.dir)) {
            budgetBlocked.add(f.dir);
            p.log(`⛔ ${f.dir} en attente : ${err.message}`);
            await notifyBudget(p, {
              account: err.account,
              mode: 'cap',
              spentEur: err.spentEur,
              limitEur: err.limitEur,
            });
          }
          continue;
        }
        // Le marqueur évite de relancer en boucle ; l'alerte d'échec est déjà partie si le contenu
        // existait (runner), sinon l'échec a eu lieu à l'ingestion et on la déclenche ici
        const message = err instanceof Error ? err.message : String(err);
        writeProcessedMarker(f.dir, {
          contentId: row?.id ?? null,
          status: 'failed',
          error: message,
        });
        p.log(`✖ ${f.dir} : ${message}`);
        if (!row) {
          await notifyFailed(p, {
            event: 'failed',
            contentId: path.basename(f.dir),
            account: f.account,
            step: 'ingest',
            error: message,
            workDir: f.dir,
          });
        }
      }
    }
    if (o.once) break;
    await sleep(o.intervalMs, o.signal, o.control);
  }
  return processed;
}
