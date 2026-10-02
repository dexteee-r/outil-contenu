import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Command } from 'commander';
import { APP_ICON_FILE, findRepoRoot } from '@outil/core';
import { ICON_DIR, writeIcons } from './tray.js';

/**
 * Raccourci « Outil contenu » : conhost --headless lance le lanceur sans aucune fenêtre (même
 * quand Windows Terminal est le terminal par défaut, qui ignore -WindowStyle Hidden) ; seule
 * l'icône de la zone de notification apparaît.
 */
export function shortcutSpec(repoRoot: string) {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return {
    target: path.join(system32, 'conhost.exe'),
    args: `--headless "${path.join(system32, 'cmd.exe')}" /c "${path.join(repoRoot, 'launchers', 'outil-tray.cmd')}"`,
    workingDir: repoRoot,
    icon: `${path.join(ICON_DIR, APP_ICON_FILE)},0`,
    description:
      'Outil contenu : surveillance des rushs et tableau de bord (icône près de l’horloge)',
  };
}

// Valeurs passées par variables d'environnement : aucun souci de guillemets ni d'accents
const CREATE_SHORTCUT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = $env:OUTIL_LNK_DIR
if (-not $dir) { $dir = [Environment]::GetFolderPath('Desktop') }
$file = Join-Path $dir 'Outil contenu.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($file)
$lnk.TargetPath = $env:OUTIL_LNK_TARGET
$lnk.Arguments = $env:OUTIL_LNK_ARGS
$lnk.WorkingDirectory = $env:OUTIL_LNK_WD
$lnk.IconLocation = $env:OUTIL_LNK_ICON
$lnk.Description = $env:OUTIL_LNK_DESC
$lnk.Save()
Write-Output $file
`;

export function registerTraySetupCommand(program: Command): void {
  program
    .command('tray:setup')
    .description(
      'Génère les icônes et crée le raccourci « Outil contenu » (lancement sans fenêtre)',
    )
    .option('--dir <dossier>', 'dossier du raccourci (Bureau par défaut)')
    .action(async (opts: { dir?: string }) => {
      if (process.platform !== 'win32') throw new Error('raccourci : Windows seulement');
      await writeIcons();
      const spec = shortcutSpec(findRepoRoot());
      const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', CREATE_SHORTCUT],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OUTIL_LNK_DIR: opts.dir ? path.resolve(opts.dir) : '',
            OUTIL_LNK_TARGET: spec.target,
            OUTIL_LNK_ARGS: spec.args,
            OUTIL_LNK_WD: spec.workingDir,
            OUTIL_LNK_ICON: spec.icon,
            OUTIL_LNK_DESC: spec.description,
          },
        },
      );
      if (res.status !== 0) {
        throw new Error(`raccourci non créé : ${res.stderr || res.error?.message}`);
      }
      console.log(`raccourci : ${res.stdout.trim()}`);
    });
}
