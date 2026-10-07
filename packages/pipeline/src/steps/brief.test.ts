import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefSection, buildTaggingPrompt, findRepoRoot, promptsDir } from '@outil/core';
import { readBrief } from './ingest.js';

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('brief', () => {
  it('lit brief.txt (BOM et blancs retirés), rien sans fichier ou s’il est vide', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-brief-'));
    expect(readBrief(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'Brief.TXT'), '﻿  Je remplace la 4060 par une 4060 Ti.\n');
    expect(readBrief(dir)).toBe('Je remplace la 4060 par une 4060 Ti.');
    fs.writeFileSync(path.join(dir, 'Brief.TXT'), '   ');
    expect(readBrief(dir)).toBeUndefined();
    expect(readBrief(path.join(dir, 'absent'))).toBeUndefined();
  });

  it('passe dans le prompt de dérushage comme contexte qui fait foi', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-brief-'));
    const prompts = promptsDir(findRepoRoot(import.meta.dirname));
    const prompt = buildTaggingPrompt({
      contentType: 'tech-repair',
      clips: [],
      dir: prompts,
      brief: 'Upgrade 4060 → 4060 Ti pour un pote.',
    });
    expect(prompt).toContain("## Contexte donné par l'auteur des rushs (fait foi)");
    expect(prompt).toContain('Upgrade 4060 → 4060 Ti pour un pote.');
    expect(briefSection(undefined)).toBe('');
  });
});
