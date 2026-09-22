import fs from 'node:fs';
import path from 'node:path';

/**
 * Miniatures YouTube pour la bibliothèque d'inspiration. YouTube les publie à des adresses fixes,
 * sans clé ni API : https://img.youtube.com/vi/<id>/<variante>.jpg. Les Shorts ont en plus une
 * variante verticale 1080x1920 (`oardefault`). Le titre et la chaîne viennent de l'oEmbed public.
 */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extrait l'identifiant de 11 caractères d'un lien YouTube (watch, youtu.be, shorts, embed, live) ou d'un id nu. */
export function parseYoutubeId(input: string): string | null {
  const raw = input.trim();
  if (ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    candidate = url.searchParams.get('v');
    if (!candidate) {
      const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      candidate = m?.[2] ?? null;
    }
  }
  return candidate && ID_RE.test(candidate) ? candidate : null;
}

export function isShortsUrl(input: string): boolean {
  return /youtube\.com\/shorts\//i.test(input);
}

export interface ThumbnailVariant {
  name: string;
  url: string;
  format: '16x9' | '9x16';
}

/** Variantes à essayer, de la meilleure à la moins bonne, pour chaque format. */
export function thumbnailVariants(id: string): ThumbnailVariant[] {
  const base = `https://i.ytimg.com/vi/${id}`;
  return [
    { name: 'oardefault', url: `${base}/oardefault.jpg`, format: '9x16' },
    { name: 'maxresdefault', url: `${base}/maxresdefault.jpg`, format: '16x9' },
    { name: 'sddefault', url: `${base}/sddefault.jpg`, format: '16x9' },
    { name: 'hqdefault', url: `${base}/hqdefault.jpg`, format: '16x9' },
  ];
}

export type HttpGet = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export interface DownloadedThumbnail {
  format: '16x9' | '9x16';
  variant: string;
  file: string;
  bytes: number;
}

export interface InspirationEntry {
  id: string;
  url: string;
  title: string | null;
  channel: string | null;
  addedAt: string;
  files: DownloadedThumbnail[];
}

/** Nom de fichier lisible : « chaine - titre » simplifié, borné, sans caractères interdits sous Windows. */
export function slugForFile(title: string | null, id: string): string {
  const base = (title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents combinants
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/g, '');
  return base ? `${base}-${id}` : id;
}

/** Titre et chaîne via l'oEmbed public de YouTube (null si indisponible, ce n'est pas bloquant). */
export async function fetchYoutubeMeta(
  id: string,
  fetchImpl: HttpGet = globalThis.fetch,
): Promise<{ title: string | null; channel: string | null }> {
  try {
    const res = await fetchImpl(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
    );
    if (!res.ok) return { title: null, channel: null };
    const data = (await res.json()) as { title?: unknown; author_name?: unknown };
    return {
      title: typeof data.title === 'string' ? data.title : null,
      channel: typeof data.author_name === 'string' ? data.author_name : null,
    };
  } catch {
    return { title: null, channel: null };
  }
}

/**
 * Télécharge la meilleure miniature 16:9 et, si elle existe (Shorts), la verticale 9:16.
 * Une variante absente répond 404 : on passe à la suivante.
 */
export async function downloadYoutubeThumbnails(
  input: string,
  outDir: string,
  fetchImpl: HttpGet = globalThis.fetch,
): Promise<InspirationEntry> {
  const id = parseYoutubeId(input);
  if (!id) throw new Error(`lien YouTube non reconnu : ${input}`);
  const meta = await fetchYoutubeMeta(id, fetchImpl);
  const slug = slugForFile(
    meta.channel && meta.title ? `${meta.channel} ${meta.title}` : meta.title,
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const files: DownloadedThumbnail[] = [];
  const done = new Set<string>();
  for (const v of thumbnailVariants(id)) {
    if (done.has(v.format)) continue;
    const res = await fetchImpl(v.url);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) continue; // image de remplacement « pas de miniature »
    const file = path.join(outDir, `${slug}-${v.format}.jpg`);
    fs.writeFileSync(file, buf);
    files.push({ format: v.format, variant: v.name, file, bytes: buf.length });
    done.add(v.format);
  }
  if (files.length === 0) throw new Error(`aucune miniature disponible pour ${id}`);

  const entry: InspirationEntry = {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: meta.title,
    channel: meta.channel,
    addedAt: new Date().toISOString(),
    files,
  };
  appendIndex(outDir, entry);
  return entry;
}

export const INSPIRATION_INDEX = 'index.json';

/** Index des miniatures récupérées (titre, chaîne, lien) : sert à les analyser ensuite. */
export function appendIndex(outDir: string, entry: InspirationEntry): void {
  const file = path.join(outDir, INSPIRATION_INDEX);
  const current = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as InspirationEntry[])
    : [];
  const next = [...current.filter((e) => e.id !== entry.id), entry];
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}
