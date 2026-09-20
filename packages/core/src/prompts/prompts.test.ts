import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../env.js';
import { loadReferenceClips } from '../schemas/fixtures.js';
import { buildTaggingPrompt, describeClips, loadPrompt, promptsDir } from './index.js';

const dir = promptsDir(findRepoRoot(import.meta.dirname));
const clips = loadReferenceClips();

describe('loadPrompt', () => {
  it('charge les prompts versionnés du repo', () => {
    expect(loadPrompt('tagging-generic', dir)).toContain('highlights');
    expect(() => loadPrompt('inexistant', dir)).toThrow(/introuvable/);
  });
});

describe('describeClips', () => {
  it('liste id, durée, dimensions et absence d’audio', () => {
    const text = describeClips([{ ...clips[0]!, hasAudio: false }]);
    expect(text).toBe('1. clipId "rush-01" — 42.0 s, 1080x1920, sans piste audio');
  });
});

describe('buildTaggingPrompt', () => {
  it('ajoute le prompt TCG seulement pour tcg-opening', () => {
    const tcg = buildTaggingPrompt({ contentType: 'tcg-opening', clips, dir });
    const generic = buildTaggingPrompt({ contentType: 'generic', clips, dir });
    const nature = buildTaggingPrompt({ contentType: 'nature-walk', clips, dir });
    expect(tcg).toContain('ouverture de cartes');
    expect(tcg).toContain('climax');
    expect(generic).not.toContain('ouverture de cartes');
    expect(nature).toContain('balade');
  });

  it('termine par la liste des clips avec leurs ids exacts', () => {
    const prompt = buildTaggingPrompt({ contentType: 'generic', clips, dir });
    expect(prompt).toContain('clipId "rush-01" — 42.0 s');
    expect(prompt).toContain('clipId "rush-02" — 18.5 s');
    expect(prompt.indexOf('## Clips fournis')).toBeGreaterThan(prompt.indexOf('## Règles'));
  });
});
