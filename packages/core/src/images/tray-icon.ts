import fs from 'node:fs';
import path from 'node:path';
import { ICO_SIZES, svgToIco } from './ico.js';

/** États affichés par l'icône de la zone de notification. */
export const TRAY_STATES = ['idle', 'running', 'paused', 'error'] as const;
export type TrayState = (typeof TRAY_STATES)[number];

export const TRAY_COLORS: Record<TrayState, string> = {
  idle: '#8A8F98', // gris : en attente
  running: '#2FBF71', // vert : job en cours
  paused: '#F2B134', // ambre : watcher en pause
  error: '#E5484D', // rouge : dernier job en échec
};

/** Carré arrondi coloré avec un triangle « lecture » blanc ; lisible dès 16 px. */
export function trayIconSvg(state: TrayState, size: number): string {
  const r = Math.round(size * 0.22);
  const inset = size * 0.28;
  const tri = [
    [inset, inset * 0.85],
    [size - inset * 0.9, size / 2],
    [inset, size - inset * 0.85],
  ]
    .map(([x, y]) => `${x!.toFixed(1)},${y!.toFixed(1)}`)
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${TRAY_COLORS[state]}"/>
  <polygon points="${tri}" fill="#FFFFFF"/>
</svg>`;
}

export function trayIconFileName(state: TrayState): string {
  return `tray-${state}.ico`;
}

/** Écrit un .ico par état dans `outDir` et renvoie les chemins. */
export async function buildTrayIcons(outDir: string): Promise<Record<TrayState, string>> {
  fs.mkdirSync(outDir, { recursive: true });
  const entries = await Promise.all(
    TRAY_STATES.map(async (state) => {
      const file = path.join(outDir, trayIconFileName(state));
      fs.writeFileSync(file, await svgToIco((size) => trayIconSvg(state, size), ICO_SIZES));
      return [state, file] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<TrayState, string>;
}
