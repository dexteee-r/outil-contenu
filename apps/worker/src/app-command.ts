import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { desc, eq } from 'drizzle-orm';
import { closeDb, jobs, openDb } from '@outil/core';
import {
  createPipelineContext,
  JobQueue,
  runWatcher,
  WatchControl,
  type PipelineNotice,
} from '@outil/pipeline';
import { backupData, backupName } from './backup.js';
import { createContext } from './context.js';
import { startDashboard } from './dashboard-server.js';
import { startTray, trayView, writeIcons, type Tray, type TrayCommand } from './tray/tray.js';

const stamp = () => new Date().toLocaleTimeString('fr-FR');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Arrêt propre sur Ctrl+C / fermeture de la fenêtre / « Quitter » du tray : l'étape en cours se
 * termine, les contenus seront repris au prochain lancement ; une seconde demande arrête tout de
 * suite.
 */
export function installStopHandlers(
  controller: AbortController,
  log: (m: string) => void,
): { uninstall: () => void; stop: (reason: string, againHint?: string) => void } {
  let forceTimer: NodeJS.Timeout | undefined;
  const stop = (reason: string, againHint = 'Ctrl+C encore pour arrêter tout de suite') => {
    if (controller.signal.aborted) {
      log(`${reason} : arrêt immédiat (le contenu en cours sera repris au prochain lancement)`);
      process.exit(130);
    }
    log(`${reason} : arrêt propre — l'étape en cours se termine (${againHint})`);
    controller.abort();
    // Garde-fou : au-delà de 5 min, on sort quand même ; l'état est sauvé à chaque étape
    forceTimer = setTimeout(() => process.exit(0), 5 * 60_000);
    forceTimer.unref();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;
  const handlers = signals.map((s) => [s, () => stop(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  return {
    stop,
    uninstall: () => {
      clearTimeout(forceTimer);
      for (const [s, h] of handlers) process.off(s, h);
    },
  };
}

/** Journal du processus : console, fichier du jour (sans fenêtre, c'est la seule trace) et mémoire tampon pour le tableau de bord. */
export function createLogBuffer(
  max = 500,
  file?: string,
): { log: (m: string) => void; lines: () => string[] } {
  const buffer: string[] = [];
  return {
    log: (message: string) => {
      const line = `[${stamp()}] ${message}`;
      console.log(line);
      if (file) {
        try {
          fs.appendFileSync(file, `${line}\n`);
        } catch {
          /* disque de données débranché : la console et le tableau de bord suffisent */
        }
      }
      buffer.push(line);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
    },
    lines: () => buffer,
  };
}

/** Ouvre une URL, un dossier ou un fichier avec l'application par défaut. */
function openTarget(target: string): void {
  exec(process.platform === 'win32' ? `start "" "${target}"` : `xdg-open "${target}"`);
}

/** Vrai si un tableau de bord de l'outil répond déjà sur ce port (second double-clic). */
async function dashboardRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok && 'queue' in ((await res.json()) as object);
  } catch {
    return false;
  }
}

/** `app` : l'outil complet — tableau de bord + surveillance de /raw, dans un seul processus. */
export function registerAppCommand(program: Command): void {
  program
    .command('app')
    .description('Lance l’outil : tableau de bord dans le navigateur + surveillance de /raw')
    .option('--port <n>', 'port du tableau de bord', '4300')
    .option('--lan', 'accessible depuis le réseau local (téléphone) — sans mot de passe')
    .option('--no-open', 'ne pas ouvrir le navigateur')
    .option('--no-watch', 'tableau de bord seul, sans surveiller /raw')
    .option(
      '--tray',
      'icône dans la zone de notification au lieu de la fenêtre (raccourci « Outil contenu »)',
    )
    .action(
      async (opts: {
        port: string;
        lan?: boolean;
        open: boolean;
        watch: boolean;
        tray?: boolean;
      }) => {
        const ctx = createContext();
        const logFile = path.join(
          ctx.paths.root,
          'logs',
          `outil-${backupName(new Date()).slice(0, 10)}.log`,
        );
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const { log, lines } = createLogBuffer(500, logFile);
        process.on('uncaughtException', (err) => {
          log(`✖ erreur inattendue : ${err.stack ?? err.message}`);
          process.exit(1);
        });

        // Instance unique : un second double-clic ouvre simplement le tableau de bord
        const port = Number(opts.port);
        if (await dashboardRunning(port)) {
          log(`l’outil tourne déjà : ouverture de http://127.0.0.1:${port}`);
          openTarget(`http://127.0.0.1:${port}`);
          return;
        }
        // Régénérées à chaque lancement : jamais d'icône manquante ou périmée
        if (opts.tray) await writeIcons();

        let tray: Tray | undefined;
        let lastFailure: string | null = null;
        const notice = (n: PipelineNotice) => {
          if (n.kind === 'ready') {
            lastFailure = null;
            tray?.toast({ title: 'Contenu prêt', text: `${n.title}\n${n.contentId}` });
          } else if (n.kind === 'budget') {
            const cap = n.mode === 'cap';
            tray?.toast({
              title: cap ? `Plafond atteint : ${n.account}` : `Seuil dépassé : ${n.account}`,
              text:
                `${n.spentEur.toFixed(2)} € ce mois-ci (limite ${n.limitEur.toFixed(2)} €)` +
                (cap ? ' — nouvelles générations suspendues.' : ''),
              error: cap,
            });
          } else {
            lastFailure = n.contentId;
            tray?.toast({
              title: `Échec : ${n.contentId}`,
              text: `Étape ${n.step} : ${n.error}`,
              error: true,
            });
          }
        };

        const db = openDb({ file: ctx.paths.db });
        const p = createPipelineContext(ctx, db, log, notice);
        const queue = new JobQueue();
        const control = opts.watch ? new WatchControl() : undefined;
        const controller = new AbortController();
        const { uninstall, stop } = installStopHandlers(controller, log);

        let started: Awaited<ReturnType<typeof startDashboard>>;
        try {
          started = await startDashboard({
            p,
            queue,
            control,
            logs: lines,
            signal: controller.signal,
            port,
            host: opts.lan ? '0.0.0.0' : '127.0.0.1',
          });
        } catch (err) {
          uninstall();
          closeDb(db);
          const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
          const message = busy
            ? `le port ${port} est pris par un autre programme (relancer avec --port)`
            : `tableau de bord impossible à démarrer : ${errorText(err)}`;
          log(`✖ ${message}`);
          throw new Error(message, { cause: err });
        }
        const { url, server } = started;
        log(`tableau de bord : ${url}${opts.lan ? ' (aussi sur le réseau local)' : ''}`);

        // ─── Icône de la zone de notification ───────────────────────────────
        const currentStep = () =>
          p.db
            .select({ step: jobs.currentStep })
            .from(jobs)
            .where(eq(jobs.status, 'running'))
            .orderBy(desc(jobs.id))
            .get()?.step ?? null;
        const refreshTray = () => {
          if (!tray) return;
          const q = queue.status();
          tray.update(
            trayView({
              current: q.current ? { label: q.current.label, step: currentStep() } : null,
              waiting: q.waiting.length,
              pendingFolders:
                control?.lastScan?.folders.filter((f) => f.videos.length > 0).length ?? 0,
              watching: !!control,
              paused: control?.paused ?? false,
              stopping: controller.signal.aborted,
              lastFailure,
            }),
          );
        };
        const onCommand = (cmd: TrayCommand) => {
          switch (cmd) {
            case 'dashboard':
              openTarget(url);
              break;
            case 'ready':
              fs.mkdirSync(ctx.paths.ready(), { recursive: true });
              openTarget(ctx.paths.ready());
              break;
            case 'scan':
              log('traitement immédiat demandé depuis l’icône');
              control?.scanNow();
              break;
            case 'pause':
              if (control) {
                control.paused = !control.paused;
                log(control.paused ? 'surveillance mise en pause' : 'surveillance reprise');
              }
              break;
            case 'log':
              openTarget(logFile);
              break;
            case 'quit':
              stop('Quitter', '« Forcer l’arrêt » dans le menu pour arrêter tout de suite');
              break;
          }
          refreshTray();
        };
        let ticker: NodeJS.Timeout | undefined;
        if (opts.tray) {
          tray = startTray({
            log,
            onCommand,
            // Icône fermée (tuée, plantée) : on ne laisse pas tourner un outil invisible
            onLost: (reason) => {
              log(`icône : ${reason}`);
              if (!controller.signal.aborted) stop('icône fermée');
            },
          });
          ticker = setInterval(refreshTray, 1000);
          refreshTray();
          tray.toast({
            title: 'Outil contenu lancé',
            text: 'Clic sur l’icône : tableau de bord. Clic droit : menu (pause, quitter…).',
          });
        } else {
          log(
            'laisse cette fenêtre ouverte ; Ctrl+C ou fermer la fenêtre arrête l’outil proprement',
          );
          if (opts.open) openTarget(url);
        }

        try {
          if (control) {
            log(
              `surveillance de ${ctx.paths.raw()} — un dossier est traité après ${ctx.env.WATCH_QUIET_MINUTES} min sans changement`,
            );
            await runWatcher(p, {
              quietMs: ctx.env.WATCH_QUIET_MINUTES * 60_000,
              intervalMs: 15_000,
              signal: controller.signal,
              queue,
              control,
            });
          } else {
            await new Promise<void>((resolve) =>
              controller.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          // Les travaux lancés depuis le tableau de bord s'arrêtent eux aussi entre deux étapes
          await queue.idle();
          refreshTray();
          try {
            const { dir, removed } = await backupData({
              db,
              accountsDir: ctx.accountsDir,
              backupRoot: path.join(ctx.paths.root, 'backups'),
            });
            log(
              `sauvegarde : ${dir}${removed.length ? ` (${removed.length} plus ancienne(s) retirée(s))` : ''}`,
            );
          } catch (err) {
            log(`✖ sauvegarde impossible : ${errorText(err)}`);
          }
          log('outil arrêté');
        } finally {
          clearInterval(ticker);
          uninstall();
          server.close();
          closeDb(db);
          await tray?.close();
        }
      },
    );
}
