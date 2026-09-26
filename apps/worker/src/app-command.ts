import { exec } from 'node:child_process';
import type { Command } from 'commander';
import { closeDb, openDb } from '@outil/core';
import { createPipelineContext, JobQueue, runWatcher, WatchControl } from '@outil/pipeline';
import { createContext } from './context.js';
import { startDashboard } from './dashboard-server.js';

const stamp = () => new Date().toLocaleTimeString('fr-FR');

/**
 * Arrêt propre sur Ctrl+C / fermeture de la fenêtre : l'étape en cours se termine, les contenus
 * seront repris au prochain lancement ; un second signal arrête tout de suite.
 */
export function installStopHandlers(
  controller: AbortController,
  log: (m: string) => void,
): () => void {
  let forceTimer: NodeJS.Timeout | undefined;
  const stop = (signal: string) => {
    if (controller.signal.aborted) {
      log(`${signal} : arrêt immédiat (le contenu en cours sera repris au prochain lancement)`);
      process.exit(130);
    }
    log(
      `${signal} : arrêt propre — l'étape en cours se termine (Ctrl+C encore pour arrêter tout de suite)`,
    );
    controller.abort();
    // Garde-fou : au-delà de 5 min, on sort quand même ; l'état est sauvé à chaque étape
    forceTimer = setTimeout(() => process.exit(0), 5 * 60_000);
    forceTimer.unref();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;
  const handlers = signals.map((s) => [s, () => stop(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  return () => {
    clearTimeout(forceTimer);
    for (const [s, h] of handlers) process.off(s, h);
  };
}

/** Journal du processus : console + mémoire tampon pour le tableau de bord. */
export function createLogBuffer(max = 500): { log: (m: string) => void; lines: () => string[] } {
  const buffer: string[] = [];
  return {
    log: (message: string) => {
      const line = `[${stamp()}] ${message}`;
      console.log(line);
      buffer.push(line);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
    },
    lines: () => buffer,
  };
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
    .action(async (opts: { port: string; lan?: boolean; open: boolean; watch: boolean }) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      const { log, lines } = createLogBuffer();
      const p = createPipelineContext(ctx, db, log);
      const queue = new JobQueue();
      const control = opts.watch ? new WatchControl() : undefined;
      const controller = new AbortController();
      const uninstall = installStopHandlers(controller, log);

      const { url, server } = await startDashboard({
        p,
        queue,
        control,
        logs: lines,
        signal: controller.signal,
        port: Number(opts.port),
        host: opts.lan ? '0.0.0.0' : '127.0.0.1',
      });
      log(`tableau de bord : ${url}${opts.lan ? ' (aussi sur le réseau local)' : ''}`);
      log('laisse cette fenêtre ouverte ; Ctrl+C ou fermer la fenêtre arrête l’outil proprement');
      if (opts.open) exec(process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`);

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
        log('outil arrêté');
      } finally {
        uninstall();
        server.close();
        closeDb(db);
      }
    });
}
