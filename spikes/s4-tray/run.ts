/**
 * Spike S4 — icône de zone de notification avec systray2.
 *
 * Vérifie : l'icône apparaît, le menu répond, l'icône change d'état, « Ouvrir le dashboard »
 * lance le navigateur, « Quitter » tue proprement le processus enfant et le helper Go.
 * Lancement : pnpm -C spikes s4 (Ctrl+C ou menu Quitter pour arrêter).
 */
import { exec, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SysTrayModule from 'systray2';
import type { MenuItem } from 'systray2';
import { buildTrayIcons, TRAY_STATES, type TrayState } from '@outil/core';

// Module CommonJS compilé par TypeScript : selon le loader, la classe est sur `.default`
const SysTray =
  (SysTrayModule as unknown as { default?: typeof SysTrayModule }).default ?? SysTrayModule;

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// 1. Icônes (.ico multi-tailles générés par sharp, un par état)
const icons = await buildTrayIcons(path.join(here, 'out'));
log(`icônes générées : ${Object.values(icons).join(', ')}`);

// 2. Faux dashboard : un serveur HTTP minimal pour tester « Ouvrir le dashboard »
const server = http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Spike S4</h1><p>Si tu vois cette page, « Ouvrir le dashboard » fonctionne.</p>');
  })
  .listen(PORT, '127.0.0.1', () => log(`faux dashboard sur http://localhost:${PORT}`));

// 3. Faux worker : un processus enfant qui doit mourir avec le tray
const worker: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
log(`faux worker démarré (pid ${worker.pid})`);

// 4. Menu
let stateIndex = 0;
const statusItem: MenuItem = { title: 'Statut : en attente', tooltip: '', enabled: false };
const openItem: MenuItem = { title: 'Ouvrir le dashboard', tooltip: `http://localhost:${PORT}` };
const cycleItem: MenuItem = {
  title: 'Changer d’état (test icône)',
  tooltip: 'idle → running → paused → error',
};
const quitItem: MenuItem = { title: 'Quitter', tooltip: 'arrête le worker et le tray' };

const menuFor = (state: TrayState) => ({
  icon: icons[state],
  title: '',
  tooltip: `Outil contenu — ${state}`,
  items: [statusItem, SysTray.separator, openItem, cycleItem, SysTray.separator, quitItem],
});

const tray = new SysTray({ menu: menuFor('idle'), debug: false, copyDir: false });

async function shutdown(reason: string) {
  log(`arrêt (${reason})`);
  worker.kill();
  server.close();
  await tray.kill(false);
  log(`faux worker tué : ${worker.killed} · helper tray tué : ${tray.killed}`);
  process.exit(0);
}

// Le helper Go est lancé de façon asynchrone : attendre `ready()` avant de brancher les handlers
await tray.ready();
tray.onError((err) => log(`ERREUR tray : ${err.message}`));
tray.onExit((code, signal) => log(`helper tray terminé (code ${code}, signal ${signal})`));

await tray.onClick((action) => {
  void handleClick(action.item.title);
});

async function handleClick(title: string) {
  log(`clic : ${title}`);
  if (title === openItem.title) {
    exec(`start "" "http://localhost:${PORT}"`);
  } else if (title === cycleItem.title) {
    stateIndex = (stateIndex + 1) % TRAY_STATES.length;
    const state = TRAY_STATES[stateIndex]!;
    statusItem.title = `Statut : ${state}`;
    await tray.sendAction({ type: 'update-menu', menu: menuFor(state) });
    log(`icône → ${state}`);
  } else if (title === quitItem.title) {
    await shutdown('menu Quitter');
  }
}

log(
  `tray prêt (helper pid ${tray.process.pid}) — regarde la zone de notification (flèche ^ à côté de l’horloge si l’icône est masquée)`,
);

process.on('SIGINT', () => void shutdown('Ctrl+C'));
