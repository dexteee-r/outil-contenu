import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { desc, eq, gte } from 'drizzle-orm';
import {
  apiCalls,
  contents,
  feedback,
  jobs,
  jobSteps,
  listAccounts,
  loadAccount,
  METADATA_FILENAME,
} from '@outil/core';
import {
  locateState,
  PROCESSED_MARKER,
  regenerateThumbnails,
  resumeContent,
  startFeedback,
  type JobQueue,
  type PipelineContext,
  type PipelineState,
  type WatchControl,
} from '@outil/pipeline';

/**
 * Tableau de bord local : suivre les contenus, relire et copier les légendes, regarder la vidéo,
 * relancer avec un feedback, déposer des rushs, suivre les coûts. Servi par le même processus que
 * la surveillance de /raw : les actions passent par la même file de travaux (un traitement à la fois).
 */

const PAGE_FILE = fileURLToPath(new URL('./dashboard-page.html', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashboardOptions {
  p: PipelineContext;
  queue: JobQueue;
  control?: WatchControl | undefined;
  /** Dernières lignes du journal du processus */
  logs: () => string[];
  /** Arrêt propre : les travaux lancés depuis le tableau de bord s'arrêtent entre deux étapes */
  signal?: AbortSignal | undefined;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 100_000) throw new HttpError(413, 'requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

/** Nom de fichier ou de dossier sûr : pas de chemin, pas de fichier caché, caractères Windows valides. */
export function safeSegment(name: string): string | null {
  if (!name || name.length > 120 || name !== path.basename(name.replace(/\\/g, '/'))) return null;
  if (name.startsWith('.') || /[<>:"/\\|?*]/.test(name)) return null;
  if ([...name].some((c) => c.charCodeAt(0) < 32)) return null;
  return name;
}

/** Fichier servi avec prise en charge des plages (le lecteur vidéo peut avancer/reculer). */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

const tryState = (p: PipelineContext, id: string): PipelineState | null => {
  try {
    return locateState(p, id);
  } catch {
    return null;
  }
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createDashboardServer(o: DashboardOptions): http.Server {
  const { p, queue } = o;
  const readyDirOf = (id: string, account: string) => p.ctx.paths.ready(account, id);

  const contentRow = (id: string) => {
    const row = p.db.select().from(contents).where(eq(contents.id, id)).get();
    if (!row) throw new HttpError(404, `contenu inconnu : ${id}`);
    return row;
  };

  const costByContent = () => {
    const map = new Map<string, number>();
    for (const c of p.db.select().from(apiCalls).all()) {
      if (c.contentId && c.costUsd != null) {
        map.set(c.contentId, (map.get(c.contentId) ?? 0) + c.costUsd);
      }
    }
    return map;
  };

  /** Action lancée en file ; l'erreur éventuelle part dans le journal (et sur Discord via le runner). */
  const enqueue = (label: string, fn: () => Promise<unknown>) => {
    void queue.run(label, fn).catch((err: unknown) => p.log(`✖ ${label} : ${errorText(err)}`));
  };

  const listContents = (account: string | null) => {
    const costs = costByContent();
    return p.db
      .select()
      .from(contents)
      .orderBy(desc(contents.createdAt))
      .all()
      .filter((r) => !account || r.account === account)
      .map((r) => {
        const s = tryState(p, r.id);
        const captions = s?.captions ? Object.values(s.captions) : [];
        const preview =
          s?.deliveredDir && s.thumbnails
            ? (s.thumbnails.find((t) => t.format === '16x9' && t.selected) ?? s.thumbnails[0])
            : undefined;
        return {
          id: r.id,
          account: r.account,
          status: r.status,
          version: r.version,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          title: captions[0]?.title ?? null,
          thumbnailTitle: s?.thumbnailTitle ?? null,
          durationSec: s?.render?.durationSec ?? null,
          preview: preview ? path.basename(preview.path) : null,
          costUsd: costs.get(r.id) ?? null,
        };
      });
  };

  const contentDetail = (id: string) => {
    const row = contentRow(id);
    const s = tryState(p, id);
    const readyDir = readyDirOf(id, row.account);
    const exists = fs.existsSync(readyDir);
    const filesIn = (dir: string) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => /^video\.mp4$|^thumb-.*\.png$/i.test(n))
            .sort()
        : [];
    const versions = exists
      ? fs
          .readdirSync(readyDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
          .map((d) => ({
            version: Number(d.name.slice(1)),
            files: filesIn(path.join(readyDir, d.name)),
          }))
          .sort((a, b) => b.version - a.version)
      : [];
    // Légendes livrées (crédit musique compris) si disponibles, sinon celles de l'état
    const metaFile = path.join(readyDir, METADATA_FILENAME);
    const delivered = fs.existsSync(metaFile)
      ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { captions?: unknown })
      : null;
    const jobRows = p.db
      .select()
      .from(jobs)
      .where(eq(jobs.contentId, id))
      .orderBy(desc(jobs.id))
      .all();
    const stepRows = p.db.select().from(jobSteps).all();
    const calls = p.db.select().from(apiCalls).where(eq(apiCalls.contentId, id)).all();
    const byModule: Record<string, number> = {};
    for (const c of calls) byModule[c.module] = (byModule[c.module] ?? 0) + (c.costUsd ?? 0);
    return {
      ...row,
      readyDir,
      files: filesIn(readyDir),
      versions,
      captions: delivered?.captions ?? s?.captions ?? null,
      thumbnailTitle: s?.thumbnailTitle ?? null,
      thumbnails: (s?.thumbnails ?? []).map((t) => ({
        name: path.basename(t.path),
        format: t.format,
        variant: t.variant,
        selected: t.selected,
      })),
      render: s?.render ?? null,
      music: s?.music ?? null,
      edl: s?.edl ? { notes: s.edl.notes, segments: s.edl.segments.length } : null,
      models: s?.models ?? {},
      completedSteps: s?.completedSteps ?? [],
      feedback: p.db
        .select()
        .from(feedback)
        .where(eq(feedback.contentId, id))
        .orderBy(desc(feedback.id))
        .all(),
      jobs: jobRows.map((j) => ({ ...j, steps: stepRows.filter((st) => st.jobId === j.id) })),
      costUsd: calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
      costByModule: byModule,
    };
  };

  const costsReport = () => {
    const since = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const rate = p.ctx.env.USD_EUR_RATE;
    const rows = p.db.select().from(apiCalls).where(gte(apiCalls.at, since)).all();
    const eur = (r: (typeof rows)[number]) => r.costEur ?? (r.costUsd ?? 0) * rate;
    const byDay: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    const monthByAccount: Record<string, number> = {};
    // Jours et mois en heure locale (les horodatages sont en UTC)
    const localDay = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const month = localDay(new Date()).slice(0, 7);
    for (const r of rows) {
      const day = localDay(new Date(r.at));
      byDay[day] = (byDay[day] ?? 0) + eur(r);
      byModule[r.module] = (byModule[r.module] ?? 0) + eur(r);
      if (day.startsWith(month)) {
        const acc = r.account ?? '(aucun)';
        monthByAccount[acc] = (monthByAccount[acc] ?? 0) + eur(r);
      }
    }
    const budgets = Object.fromEntries(
      listAccounts(p.ctx.accountsDir).map((slug) => {
        try {
          return [slug, loadAccount(slug, p.ctx.accountsDir).config.budget];
        } catch {
          return [slug, null];
        }
      }),
    );
    return { month, byDay, byModule, monthByAccount, budgets, calls: rows.length };
  };

  const accountsReport = () =>
    listAccounts(p.ctx.accountsDir).map((slug) => {
      try {
        const a = loadAccount(slug, p.ctx.accountsDir);
        const c = a.config;
        return {
          slug,
          displayName: c.displayName,
          contentType: c.contentType,
          platforms: c.platforms,
          durationRange: c.durationRange,
          subtitles: c.subtitles,
          budget: c.budget,
          musicMoods: c.musicMoods,
          warnings: a.warnings,
        };
      } catch (err) {
        return { slug, error: errorText(err) };
      }
    });

  const upload = async (req: http.IncomingMessage, url: URL) => {
    const account = url.searchParams.get('account') ?? '';
    if (!listAccounts(p.ctx.accountsDir).includes(account)) {
      throw new HttpError(400, `compte inconnu : ${account}`);
    }
    const session = safeSegment(url.searchParams.get('session') ?? '');
    const name = safeSegment(url.searchParams.get('name') ?? '');
    if (!session) throw new HttpError(400, 'nom de session invalide');
    if (!name) throw new HttpError(400, 'nom de fichier invalide');
    const dir = path.join(p.ctx.paths.raw(account), session);
    const known = p.db
      .select({ sourceDir: contents.sourceDir })
      .from(contents)
      .all()
      .some((r) => path.resolve(r.sourceDir).toLowerCase() === path.resolve(dir).toLowerCase());
    if (known || fs.existsSync(path.join(dir, PROCESSED_MARKER))) {
      throw new HttpError(
        409,
        `la session « ${session} » a déjà été traitée : choisis un autre nom`,
      );
    }
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, name);
    // .part pendant l'envoi : la surveillance ne traite jamais un fichier à moitié copié
    const partial = `${final}.part`;
    await pipeline(req, fs.createWriteStream(partial));
    fs.renameSync(partial, final);
    p.log(`dépôt : ${name} → ${dir}`);
    return { dir, name, bytes: fs.statSync(final).size };
  };

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && url.pathname === '/') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(fs.readFileSync(PAGE_FILE));
          return;
        }
        if (method === 'GET' && url.pathname === '/api/status') {
          const scan = o.control?.lastScan;
          sendJson(res, 200, {
            queue: queue.status(),
            watching: !!o.control,
            paused: o.control?.paused ?? false,
            scan: scan
              ? {
                  at: scan.at,
                  folders: scan.folders.map((f) => ({
                    account: f.account,
                    name: path.basename(f.dir),
                    videos: f.videos.length,
                    hasTemp: f.hasTemp,
                  })),
                }
              : null,
            quietMinutes: p.ctx.env.WATCH_QUIET_MINUTES,
            logs: o.logs().slice(-200),
          });
          return;
        }
        if (method === 'GET' && url.pathname === '/api/contents') {
          sendJson(res, 200, { contents: listContents(url.searchParams.get('account')) });
          return;
        }
        if (method === 'GET' && url.pathname === '/api/costs') {
          sendJson(res, 200, costsReport());
          return;
        }
        if (method === 'GET' && url.pathname === '/api/accounts') {
          sendJson(res, 200, { accounts: accountsReport() });
          return;
        }
        if (method === 'POST' && url.pathname === '/api/scan') {
          if (!o.control) throw new HttpError(409, 'la surveillance de /raw n’est pas active');
          o.control.scanNow();
          sendJson(res, 202, { ok: true });
          return;
        }
        if (method === 'POST' && url.pathname === '/api/pause') {
          if (!o.control) throw new HttpError(409, 'la surveillance de /raw n’est pas active');
          const body = await readJson(req);
          if (typeof body.paused !== 'boolean')
            throw new HttpError(400, 'paused attendu (booléen)');
          if (o.control.paused !== body.paused) {
            o.control.paused = body.paused;
            p.log(body.paused ? 'surveillance mise en pause' : 'surveillance reprise');
          }
          sendJson(res, 200, { paused: o.control.paused });
          return;
        }
        if (method === 'POST' && url.pathname === '/api/upload') {
          sendJson(res, 200, await upload(req, url));
          return;
        }

        const detail = /^\/api\/contents\/([^/]+)$/.exec(url.pathname);
        if (method === 'GET' && detail) {
          sendJson(res, 200, contentDetail(decodeURIComponent(detail[1]!)));
          return;
        }

        const action = /^\/api\/contents\/([^/]+)\/(feedback|resume|thumbnails)$/.exec(
          url.pathname,
        );
        if (method === 'POST' && action) {
          const id = decodeURIComponent(action[1]!);
          const row = contentRow(id);
          const runOptions = { signal: o.signal };
          if (action[2] === 'feedback') {
            const body = await readJson(req);
            const target = body.target === 'thumbnail' ? 'thumbnail' : 'video';
            const text = typeof body.text === 'string' ? body.text.trim() : '';
            if (!text || text.length > 1000) throw new HttpError(400, 'retour vide ou trop long');
            if (row.status !== 'ready') {
              throw new HttpError(409, `contenu pas encore livré (statut ${row.status})`);
            }
            enqueue(`feedback ${target} sur ${id}`, () =>
              startFeedback(p, id, { target, text }, runOptions),
            );
          } else if (action[2] === 'resume') {
            if (row.status === 'ready') throw new HttpError(409, 'contenu déjà livré');
            enqueue(`reprise de ${id}`, () => resumeContent(p, id, runOptions));
          } else {
            if (row.status !== 'ready') throw new HttpError(409, 'contenu pas encore livré');
            enqueue(`miniatures de ${id}`, () => regenerateThumbnails(p, id));
          }
          sendJson(res, 202, { queued: true, queue: queue.status() });
          return;
        }

        const media = /^\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (method === 'GET' && media) {
          const id = decodeURIComponent(media[1]!);
          const name = safeSegment(decodeURIComponent(media[2]!));
          const row = contentRow(id);
          const v = url.searchParams.get('v');
          const base = readyDirOf(id, row.account);
          const dir = v && /^\d+$/.test(v) ? path.join(base, `v${v}`) : base;
          const file = name ? path.join(dir, name) : null;
          if (!file || !/^video\.mp4$|^thumb-.*\.png$/i.test(name!) || !fs.existsSync(file)) {
            throw new HttpError(404, 'fichier introuvable');
          }
          serveFile(req, res, file);
          return;
        }

        throw new HttpError(404, 'introuvable');
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) sendJson(res, status, { error: errorText(err) });
        else res.end();
      }
    })();
  });
}

/** Démarre le tableau de bord ; `host` 127.0.0.1 par défaut (0.0.0.0 pour le réseau local). */
export async function startDashboard(
  options: DashboardOptions & { port: number; host?: string },
): Promise<{ url: string; server: http.Server }> {
  const server = createDashboardServer(options);
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return { url: `http://127.0.0.1:${port}`, server };
}
