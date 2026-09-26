import sharp from 'sharp';
import { retry } from '@outil/core';
import type { FailedPayload, ReadyPayload } from './notify.js';

/**
 * Messages Discord envoyés directement au webhook du salon (sans n8n) : un embed lisible depuis le
 * téléphone, la miniature en pièce jointe (le PC peut être éteint quand on lit le message).
 */

export interface DiscordMessage {
  content: string;
  embeds: Record<string, unknown>[];
  /** Pièce jointe référencée par l'embed (`attachment://<name>`) */
  file?: { name: string; data: Buffer; type: string } | undefined;
}

export type DiscordFetch = (
  url: string,
  init: { method: 'POST'; body: FormData },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const PLATFORM_LABELS: Record<string, string> = {
  'youtube-shorts': 'YouTube Shorts',
  tiktok: 'TikTok',
  'instagram-reels': 'Instagram Reels',
};

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;

/** Coupe un texte à `max` caractères (limites Discord : titre 256, champ 1024, description 4096). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function readyMessage(payload: ReadyPayload, preview: Buffer | null): DiscordMessage {
  const fields = Object.entries(payload.captions ?? {}).map(([platform, c]) => {
    const tags = c.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    return {
      name: PLATFORM_LABELS[platform] ?? platform,
      value: clip([`**${c.title}**`, c.description, tags].filter(Boolean).join('\n'), 1024),
    };
  });
  const embed: Record<string, unknown> = {
    title: clip(payload.title, 256),
    color: GREEN,
    description: clip(
      [
        `⏱️ ${Math.round(payload.durationSec)} s${payload.thumbnailTitle ? ` · 🖼️ « ${payload.thumbnailTitle} »` : ''}`,
        `📁 \`${payload.readyDir}\``,
      ].join('\n'),
      4096,
    ),
    fields: fields.slice(0, 25),
    footer: {
      text: clip(
        `${payload.contentId} · retour : pnpm content feedback ${payload.contentId} "…"`,
        2048,
      ),
    },
  };
  if (preview) embed.image = { url: 'attachment://miniature.jpg' };
  return {
    content: `✅ **Vidéo prête** — ${payload.account}`,
    embeds: [embed],
    file: preview ? { name: 'miniature.jpg', data: preview, type: 'image/jpeg' } : undefined,
  };
}

export function failedMessage(payload: FailedPayload): DiscordMessage {
  return {
    content: `❌ **Échec** — ${payload.account}`,
    embeds: [
      {
        title: clip(payload.contentId, 256),
        color: RED,
        fields: [
          { name: 'Étape', value: payload.step, inline: true },
          { name: 'Erreur', value: clip(`\`\`\`${payload.error}\`\`\``, 1024) },
          { name: 'Pour reprendre', value: `\`pnpm content resume ${payload.contentId}\`` },
        ],
      },
    ],
  };
}

export function diskMessage(
  disk: { freeGb: number; totalGb: number },
  root: string,
): DiscordMessage {
  return {
    content: '⚠️ **Disque presque plein**',
    embeds: [
      {
        title: `${disk.freeGb.toFixed(0)} Go libres sur ${disk.totalGb.toFixed(0)} Go`,
        color: 0xf39c12,
        description: clip(
          `Dossier des données : \`${root}\`\nAucune suppression automatique : fais de la place dans \`raw\` ou \`ready\`.`,
          4096,
        ),
      },
    ],
  };
}

/** Miniature allégée pour Discord (JPEG 1280 px max) : le PNG d'origine peut dépasser 2 Mo. */
export async function previewJpeg(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Envoi multipart (`payload_json` + pièce jointe), nouvelles tentatives sur 429 / 5xx. */
export async function postDiscord(
  url: string,
  message: DiscordMessage,
  fetchImpl: DiscordFetch = globalThis.fetch,
): Promise<void> {
  await retry(
    async () => {
      const form = new FormData();
      const { file, ...json } = message;
      form.append(
        'payload_json',
        JSON.stringify({
          ...json,
          ...(file ? { attachments: [{ id: 0, filename: file.name }] } : {}),
        }),
      );
      if (file)
        form.append(
          'files[0]',
          new Blob([new Uint8Array(file.data)], { type: file.type }),
          file.name,
        );
      const res = await fetchImpl(url, { method: 'POST', body: form });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw Object.assign(new Error(`Discord HTTP ${res.status} ${detail}`.trim()), {
          status: res.status,
        });
      }
    },
    { attempts: 4, baseDelayMs: 1500 },
  );
}
