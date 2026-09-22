import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadYoutubeThumbnails,
  inspirationDir,
  listAccounts,
  listInspiration,
  MAX_UPLOAD_BYTES,
  removeInspiration,
  safeImageName,
  saveUploadedImage,
  type HttpGet,
} from '@outil/core';

/**
 * Page web locale de la bibliothèque d'inspiration : coller des liens YouTube, déposer des
 * captures, voir et supprimer les miniatures. Écoute uniquement sur 127.0.0.1 (jamais exposée).
 */

const PAGE_FILE = fileURLToPath(new URL('./inspiration-page.html', import.meta.url));

export interface InspirationServerOptions {
  accountsDir: string;
  /** Téléchargement HTTP injectable (tests) */
  httpGet?: HttpGet;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw Object.assign(new Error('requête trop volumineuse'), { status: 413 });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function createInspirationServer(o: InspirationServerOptions): http.Server {
  const accountOk = (account: string | null): account is string =>
    !!account && listAccounts(o.accountsDir).includes(account);

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method ?? 'GET'} ${url.pathname}`;
      try {
        if (route === 'GET /') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(fs.readFileSync(PAGE_FILE));
          return;
        }

        if (route === 'GET /api/accounts') {
          sendJson(res, 200, { accounts: listAccounts(o.accountsDir) });
          return;
        }

        const account = url.searchParams.get('account');
        if (url.pathname.startsWith('/api/') && !accountOk(account)) {
          sendJson(res, 400, { error: `compte inconnu : ${account ?? '(aucun)'}` });
          return;
        }
        const dir = inspirationDir(o.accountsDir, account ?? '');

        if (route === 'GET /api/images') {
          sendJson(res, 200, { dir, images: listInspiration(dir) });
          return;
        }

        if (route === 'POST /api/youtube') {
          const body = JSON.parse((await readBody(req, 100_000)).toString('utf8')) as {
            links?: unknown;
          };
          const links = Array.isArray(body.links)
            ? body.links.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
            : [];
          const results = [];
          for (const link of links) {
            try {
              const entry = await downloadYoutubeThumbnails(link.trim(), dir, o.httpGet);
              results.push({
                link,
                ok: true,
                title: entry.title,
                channel: entry.channel,
                files: entry.files.map((f) => path.basename(f.file)),
              });
            } catch (err) {
              results.push({
                link,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          sendJson(res, 200, { results });
          return;
        }

        if (route === 'POST /api/upload') {
          const name = url.searchParams.get('name') ?? 'capture';
          const data = await readBody(req, MAX_UPLOAD_BYTES);
          const saved = saveUploadedImage(dir, name, data);
          sendJson(res, 200, { name: saved });
          return;
        }

        if (route === 'DELETE /api/images') {
          removeInspiration(dir, url.searchParams.get('name') ?? '');
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/image') {
          const name = safeImageName(url.searchParams.get('name') ?? '');
          if (!accountOk(account) || !name || !fs.existsSync(path.join(dir, name))) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(path.join(dir, name)).pipe(res);
          return;
        }

        sendJson(res, 404, { error: 'introuvable' });
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

/** Démarre le serveur sur 127.0.0.1:<port> et renvoie l'URL. */
export async function startInspirationServer(
  options: InspirationServerOptions & { port: number },
): Promise<{ url: string; server: http.Server }> {
  const server = createInspirationServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  // 127.0.0.1 et non « localhost » : certains navigateurs tentent d'abord ::1 (IPv6), où rien n'écoute
  return { url: `http://127.0.0.1:${port}`, server };
}
