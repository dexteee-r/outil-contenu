import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountConfigError, listAccounts, loadAccount, parseAccountConfig } from './account.js';

const VALID_YAML = `
slug: tcg
displayName: TCG
contentType: tcg-opening
platforms: [youtube-shorts, tiktok]
brand:
  logo: brand/logo.png
  colors:
    primary: "#FFCC00"
    secondary: "#1A1A2E"
    background: "#0F0F1A"
    text: "#FFFFFF"
  fonts:
    title: brand/fonts/Title.ttf
    body: Arial
captionPrompt: prompts/captions.md
musicMoods: [hype, reveal]
durationRange: { min: 15, max: 45 }
budget: { mode: threshold, monthlyLimitEur: 5 }
`;

describe('parseAccountConfig', () => {
  it('applique les défauts', () => {
    const cfg = parseAccountConfig(
      {
        slug: 'x',
        displayName: 'X',
        brand: {
          colors: {
            primary: '#000000',
            secondary: '#111111',
            background: '#222222',
            text: '#ffffff',
          },
        },
      },
      'x',
    );
    expect(cfg.contentType).toBe('generic');
    expect(cfg.platforms).toEqual(['youtube-shorts', 'tiktok', 'instagram-reels']);
    expect(cfg.subtitles).toBe(false);
    expect(cfg.overlays).toEqual(['hook']);
    expect(cfg.durationRange).toEqual({ min: 15, max: 60 });
    expect(cfg.budget).toEqual({ mode: 'unlimited' });
    expect(cfg.captionPrompt).toBe('prompts/captions.md');
  });

  it('refuse un slug différent du dossier', () => {
    expect(() =>
      parseAccountConfig(
        {
          slug: 'autre',
          displayName: 'X',
          brand: {
            colors: {
              primary: '#000000',
              secondary: '#111111',
              background: '#222222',
              text: '#ffffff',
            },
          },
        },
        'x',
      ),
    ).toThrow(AccountConfigError);
  });

  it('refuse une couleur invalide, une clé inconnue et un budget cap sans limite', () => {
    try {
      parseAccountConfig(
        {
          slug: 'x',
          displayName: 'X',
          inconnu: true,
          brand: {
            colors: {
              primary: 'jaune',
              secondary: '#111111',
              background: '#222222',
              text: '#ffffff',
            },
          },
          budget: { mode: 'cap' },
        },
        'x',
      );
      expect.fail('devait lever');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountConfigError);
      const issues = (err as AccountConfigError).issues.join('\n');
      expect(issues).toContain('brand.colors.primary');
      expect(issues).toContain('inconnu');
      expect(issues).toContain('budget');
    }
  });

  it('refuse durationRange.min > max', () => {
    expect(() =>
      parseAccountConfig(
        {
          slug: 'x',
          displayName: 'X',
          brand: {
            colors: {
              primary: '#000000',
              secondary: '#111111',
              background: '#222222',
              text: '#ffffff',
            },
          },
          durationRange: { min: 60, max: 15 },
        },
        'x',
      ),
    ).toThrow(/durationRange/);
  });
});

describe('loadAccount', () => {
  let accountsDir: string;

  beforeEach(() => {
    accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-accounts-'));
    fs.mkdirSync(path.join(accountsDir, 'tcg', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(accountsDir, 'tcg', 'account.yaml'), VALID_YAML);
    fs.writeFileSync(path.join(accountsDir, 'tcg', 'prompts', 'captions.md'), '# prompt');
  });

  afterEach(() => {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  });

  it('charge le YAML, résout les chemins et signale les fichiers absents', () => {
    const loaded = loadAccount('tcg', accountsDir);
    expect(loaded.config.displayName).toBe('TCG');
    expect(loaded.files.captionPrompt).toBe(
      path.join(accountsDir, 'tcg', 'prompts', 'captions.md'),
    );
    expect(loaded.files.logo).toBe(path.join(accountsDir, 'tcg', 'brand', 'logo.png'));
    expect(loaded.files.fontTitle).toBe(
      path.join(accountsDir, 'tcg', 'brand', 'fonts', 'Title.ttf'),
    );
    expect(loaded.files.fontBody).toBeUndefined(); // "Arial" est un nom de police, pas un fichier
    // logo et police absents, gabarit miniature absent ; le prompt existe
    expect(loaded.warnings.some((w) => w.includes('logo'))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes('police titre'))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes('prompt légendes'))).toBe(false);
  });

  it('liste les comptes qui ont un account.yaml', () => {
    fs.mkdirSync(path.join(accountsDir, 'vide'));
    expect(listAccounts(accountsDir)).toEqual(['tcg']);
  });

  it('lève une erreur claire si le fichier manque ou si le YAML est cassé', () => {
    expect(() => loadAccount('absent', accountsDir)).toThrow(/introuvable/);
    fs.writeFileSync(path.join(accountsDir, 'tcg', 'account.yaml'), 'slug: [oops');
    expect(() => loadAccount('tcg', accountsDir)).toThrow(/YAML illisible/);
  });
});
