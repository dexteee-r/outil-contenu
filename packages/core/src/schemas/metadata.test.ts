import { describe, expect, it } from 'vitest';
import { edlSchema } from './edl.js';
import { toJsonSchema } from './json-schema.js';
import {
  captionSchema,
  captionsOutputSchemaFor,
  metadataSchema,
  splitCaptionsOutput,
  THUMBNAIL_SIZES,
  type Metadata,
} from './metadata.js';
import { taggingOutputSchema } from './tagging.js';

const caption = {
  title: 'PULL ULTRA RARE',
  description: 'Ouverture du jour',
  hashtags: ['#tcg', 'pokemon'],
};

const metadata: Metadata = {
  schemaVersion: 1,
  contentId: 'tcg-2026-09-20-a3f9',
  account: 'tcg',
  version: 1,
  createdAt: '2026-09-20T12:00:00.000Z',
  video: { path: 'video.mp4', durationSec: 25.7, width: 1080, height: 1920 },
  thumbnails: [
    { path: 'thumb-9x16-1.png', format: '9x16', variant: 1, selected: true },
    { path: 'thumb-16x9-1.png', format: '16x9', variant: 1, selected: true },
  ],
  captions: { 'youtube-shorts': caption, tiktok: caption },
  aiDisclosure: { video: true, images: true, providers: ['gemini', 'anthropic'] },
  sourceFiles: ['rush-01.mp4', 'rush-02.mp4'],
  models: {
    tagging: 'gemini-x',
    edl: 'claude-sonnet-5',
    captions: 'claude-sonnet-5',
    image: 'gemini-image',
  },
};

describe('captionSchema', () => {
  it('accepte des hashtags avec ou sans # et refuse les espaces', () => {
    expect(captionSchema.safeParse(caption).success).toBe(true);
    expect(captionSchema.safeParse({ ...caption, hashtags: ['#deux mots'] }).success).toBe(false);
    expect(captionSchema.safeParse({ ...caption, title: '' }).success).toBe(false);
  });
});

describe('captionsOutputSchemaFor', () => {
  it('exige exactement les plateformes du compte', () => {
    const schema = captionsOutputSchemaFor(['tiktok', 'instagram-reels']);
    const hit = { clipId: 'rush-02', atSec: 7, what: 'carte Vergo face visible' };
    const ok = {
      tiktok: caption,
      'instagram-reels': caption,
      thumbnailTitle: 'QUEL HIT ?',
      thumbnailSubject: { clipId: 'rush-01', atSec: 2.5, what: 'booster One Piece fermé' },
      thumbnailHit: hit,
    };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, thumbnailHit: null }).success).toBe(true); // pas de carte
    expect(schema.safeParse({ tiktok: caption, 'instagram-reels': caption }).success).toBe(false); // titre miniature requis
    expect(schema.safeParse({ ...ok, thumbnailSubject: undefined }).success).toBe(false); // sujet requis
    expect(schema.safeParse({ ...ok, thumbnailHit: undefined }).success).toBe(false); // null explicite requis
    expect(splitCaptionsOutput(ok)).toEqual({
      captions: { tiktok: caption, 'instagram-reels': caption },
      thumbnailTitle: 'QUEL HIT ?',
      thumbnailSubject: { clipId: 'rush-01', atSec: 2.5, what: 'booster One Piece fermé' },
      thumbnailHit: hit,
    });
    expect(splitCaptionsOutput({ ...ok, thumbnailHit: null }).thumbnailHit).toBeNull();
    expect(
      schema.safeParse({ tiktok: caption, 'instagram-reels': caption, 'youtube-shorts': caption })
        .success,
    ).toBe(false);
  });
});

describe('metadataSchema', () => {
  it('accepte un metadata.json complet', () => {
    expect(metadataSchema.safeParse(metadata).success).toBe(true);
  });

  it('refuse une plateforme inconnue, un format de miniature inconnu, une date non ISO', () => {
    expect(metadataSchema.safeParse({ ...metadata, captions: { facebook: caption } }).success).toBe(
      false,
    );
    expect(
      metadataSchema.safeParse({
        ...metadata,
        thumbnails: [{ path: 'x.png', format: '4x3', variant: 1, selected: false }],
      }).success,
    ).toBe(false);
    expect(metadataSchema.safeParse({ ...metadata, createdAt: 'hier' }).success).toBe(false);
  });

  it('connaît les dimensions des deux formats de miniature', () => {
    expect(THUMBNAIL_SIZES['9x16']).toEqual({ width: 1080, height: 1920 });
    expect(THUMBNAIL_SIZES['16x9']).toEqual({ width: 1280, height: 720 });
  });
});

describe('toJsonSchema', () => {
  it('produit des objets fermés (additionalProperties: false) avec tous les champs requis', () => {
    for (const schema of [edlSchema, taggingOutputSchema, captionsOutputSchemaFor(['tiktok'])]) {
      const json = toJsonSchema(schema) as {
        type: string;
        additionalProperties?: boolean;
        properties: Record<string, unknown>;
        required?: string[];
        $schema?: string;
      };
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
      expect(json.required?.sort()).toEqual(Object.keys(json.properties).sort());
      expect(json.$schema).toBeUndefined();
    }
  });

  it('sait aussi cibler OpenAPI 3.0 pour Gemini', () => {
    const json = toJsonSchema(edlSchema, { target: 'openapi-3.0' }) as {
      properties: { version: unknown };
    };
    expect(json.properties.version).toBeDefined();
  });
});
