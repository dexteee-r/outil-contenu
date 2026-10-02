import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startTray, trayView, type TrayCommand, type TrayInput } from './tray.js';

const base: TrayInput = {
  current: null,
  waiting: 0,
  pendingFolders: 0,
  watching: true,
  paused: false,
  stopping: false,
  lastFailure: null,
};

describe('trayView', () => {
  it('en attente, dossiers en période de calme', () => {
    expect(trayView(base)).toMatchObject({
      icon: 'idle',
      status: 'En attente de rushs',
      canScan: false,
      canPause: true,
      pauseLabel: 'Mettre en pause la surveillance',
      quitLabel: 'Quitter',
    });
    const v = trayView({ ...base, pendingFolders: 2 });
    expect(v.status).toBe('2 dossiers en attente de la période de calme');
    expect(v.canScan).toBe(true);
  });

  it('travail en cours : étape en clair et file d’attente, prioritaire sur l’échec et la pause', () => {
    const v = trayView({
      ...base,
      current: { label: 'traitement de 2026-10-01', step: 'render' },
      waiting: 1,
      paused: true,
      lastFailure: 'tcg-x',
    });
    expect(v.icon).toBe('running');
    expect(v.status).toBe('En cours : traitement de 2026-10-01 — rendu (+1 en file)');
    expect(v.tooltip).toBe('Outil contenu — rendu en cours');
    expect(v.pauseLabel).toBe('Reprendre la surveillance');
  });

  it('échec puis pause', () => {
    expect(trayView({ ...base, lastFailure: 'tcg-2026-10-01-ab12' })).toMatchObject({
      icon: 'error',
      status: 'Échec : tcg-2026-10-01-ab12 — voir le tableau de bord',
    });
    expect(trayView({ ...base, paused: true }).icon).toBe('paused');
  });

  it('arrêt en cours : plus de pause ni de traitement, « Quitter » devient « Forcer »', () => {
    const v = trayView({ ...base, stopping: true, pendingFolders: 3 });
    expect(v.status).toContain('Arrêt en cours');
    expect([v.canPause, v.canScan]).toEqual([false, false]);
    expect(v.quitLabel).toContain('Forcer');
  });

  it('info-bulle limitée à 63 caractères (limite Windows)', () => {
    const v = trayView({ ...base, lastFailure: 'x'.repeat(200) });
    expect(v.tooltip.length).toBeLessThanOrEqual(63);
    expect(v.tooltip.endsWith('…')).toBe(true);
  });
});

/** Faux processus PowerShell : on lit ce que Node lui écrit, on simule ses clics. */
function fakeChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: () => child.emit('exit', null) });
  const received: Record<string, unknown>[] = [];
  let pending = '';
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const l of lines) {
      const m = JSON.parse(l) as Record<string, unknown>;
      received.push(m);
      if (m.type === 'exit') setImmediate(() => child.emit('exit', 0));
    }
  });
  const click = (cmd: string) => stdout.write(`{"cmd":"${cmd}"}\n`);
  return { child, received, click, stdout, stderr };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('startTray', () => {
  it('envoie libellés, état (sans doublon) et toasts ; relaie les clics connus', async () => {
    const fake = fakeChild();
    const commands: TrayCommand[] = [];
    const logs: string[] = [];
    let args: string[] = [];
    const tray = startTray({
      onCommand: (c) => commands.push(c),
      onLost: () => logs.push('perdu'),
      log: (m) => logs.push(m),
      iconDir: 'C:\\icônes',
      spawnImpl: (_cmd, a) => {
        args = a;
        return fake.child;
      },
    });
    expect(args.slice(-2)).toEqual(['-IconDir', 'C:\\icônes']);
    const view = trayView(base);
    tray.update(view);
    tray.update({ ...view });
    tray.toast({ title: 'Contenu prêt', text: 'QUEL HIT ?' });
    fake.click('pause');
    fake.click('rm -rf');
    fake.stdout.write('pas du json\n');
    fake.stderr.write('message ignore : x\n');
    await tick();

    expect(fake.received.map((m) => m.type)).toEqual(['init', 'state', 'toast']);
    expect((fake.received[0]!.labels as Record<string, string>).dashboard).toBe(
      'Ouvrir le tableau de bord',
    );
    expect(fake.received[2]).toMatchObject({ title: 'Contenu prêt', error: false });
    expect(commands).toEqual(['pause']);
    expect(logs.some((l) => l.includes('message illisible'))).toBe(true);
    expect(logs).toContain('tray : message ignore : x');

    await tray.close();
    expect(fake.received.at(-1)!.type).toBe('exit');
    expect(logs).not.toContain('perdu'); // fermeture demandée : pas d'alerte
  });

  it('icône tuée de l’extérieur : prévient (l’outil s’arrêtera proprement)', async () => {
    const fake = fakeChild();
    const lost: string[] = [];
    startTray({
      onCommand: () => undefined,
      onLost: (r) => lost.push(r),
      log: () => undefined,
      spawnImpl: () => fake.child,
    });
    fake.child.emit('exit', 1);
    await tick();
    expect(lost).toEqual(['processus de l’icône terminé (code 1)']);
  });
});
