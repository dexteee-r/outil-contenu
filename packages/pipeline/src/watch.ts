import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { contents, listAccounts } from '@outil/core';
import type { PipelineContext } from './context.js';
import { isVideoFile } from './ids.js';
import { notifyDisk, notifyFailed } from './notify.js';
import { InterruptedError, resumeContent, runContent, type RunOptions } from './runner.js';

/**
 * Surveillance de /raw/<compte>/<dossier>/ : un dossier est traité quand son contenu n'a plus
 * bougé depuis `quietMs` (transfert Syncthing terminé), qu'il contient au moins une vidéo et aucun
 * fichier temporaire. Balayage périodique plutôt qu'événements du système de fichiers : plus fiable
 * sous Windows avec les renommages de Syncthing, et testable avec une horloge injectée.
 */

/** Fichiers temporaires de Syncthing (transfert en cours). */
export const SYNCTHING_TEMP = /^(\.syncthing\..*\.tmp|~syncthing~.*)$/i;

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
      const hasTemp = files.some((f) => SYNCTHING_TEMP.test(f.name));
      const videos = files
        .map((f) => f.name)
        .filter((n) => isVideoFile(n) && !SYNCTHING_TEMP.test(n));
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
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
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
      await resumeContent(p, c.id, runOptions);
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
  for (;;) {
    if (o.signal?.aborted) break;
    await diskCheck();
    const folders = scanInbox(p);
    // Signale une fois les dossiers qui arrivent (la période de calme commence)
    const fresh = folders.filter((f) => !announced.has(f.dir));
    for (const f of fresh) {
      p.log(
        `nouveau dossier : ${f.dir} (${f.videos.length} vidéo(s)${f.hasTemp ? ', transfert en cours' : ''})`,
      );
    }
    announced = new Set(folders.map((f) => f.dir));

    for (const f of tracker.ready(folders)) {
      if (o.signal?.aborted) break;
      tracker.forget(f.dir);
      p.log(`▶▶ traitement de ${f.dir}`);
      try {
        const state = await runContent(p, { accountSlug: f.account, inputDir: f.dir }, runOptions);
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
    await sleep(o.intervalMs, o.signal);
  }
  return processed;
}
