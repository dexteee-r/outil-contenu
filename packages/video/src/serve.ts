import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Serveur de fichiers local minimal pour le rendu : le navigateur de Remotion récupère
 * les rushs et la musique par HTTP (avec Range) au lieu de copier les fichiers dans le bundle.
 * Chaque « mount » expose un fichier ou un dossier sous un préfixe d'URL.
 */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export interface MediaServer {
  /** URL de base, ex. http://127.0.0.1:53211 */
  baseUrl: string;
  /** Expose un fichier et renvoie son URL */
  mount(file: string): string;
  close(): Promise<void>;
}

/** Interprète un en-tête Range « bytes=a-b » (pur, testable). */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start = a === '' ? Math.max(0, size - Number(b)) : Number(a);
  let end = b === '' || a === '' ? size - 1 : Number(b);
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  start = Math.max(0, start);
  return { start, end };
}

export async function startMediaServer(): Promise<MediaServer> {
  const files = new Map<string, string>(); // clé URL → chemin absolu
  let counter = 0;

  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = files.get(key);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const range = parseRange(req.headers.range, size);
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    } else {
      headers['Content-Length'] = size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const urls = new Map<string, string>(); // chemin absolu → URL déjà attribuée

  return {
    baseUrl,
    mount(file) {
      const abs = path.resolve(file);
      const known = urls.get(abs);
      if (known) return known;
      const key = `/media/${counter++}/${encodeURIComponent(path.basename(abs))}`;
      files.set(decodeURIComponent(key), abs);
      const url = `${baseUrl}${key}`;
      urls.set(abs, url);
      return url;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
