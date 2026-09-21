import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeDb, openDb, type Db } from '../db/index.js';
import { apiCalls } from '../db/schema.js';
import {
  AnthropicOutputError,
  AnthropicProvider,
  type AnthropicParseParams,
  type AnthropicParsedMessage,
  type AnthropicSdk,
} from './anthropic.js';
import { UsageTracker } from './usage.js';

const PRICING = {
  'claude-sonnet-5': { kind: 'tokens' as const, inputPerMTok: 2, outputPerMTok: 10 },
};
const schema = z.object({ answer: z.number() }).strict();
const meta = { module: 'edl', provider: 'anthropic', model: 'claude-sonnet-5' } as const;

function fakeSdk(
  responses: AnthropicParsedMessage[],
): AnthropicSdk & { calls: AnthropicParseParams[] } {
  const queue = [...responses];
  const calls: AnthropicParseParams[] = [];
  return {
    calls,
    messages: {
      parse: (params) => {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error('plus de réponses');
        return Promise.resolve(next);
      },
    },
  };
}

let db: Db | undefined;
afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const provider = (sdk: AnthropicSdk) => {
  db = openDb({ file: ':memory:' });
  return new AnthropicProvider(sdk, new UsageTracker(db, { pricing: PRICING, usdEurRate: 1 }), {
    sleep: () => Promise.resolve(),
  });
};

describe('AnthropicProvider.generateStructured', () => {
  it('envoie system + messages + format Zod, renvoie la sortie typée et journalise le coût', async () => {
    const sdk = fakeSdk([
      {
        parsed_output: { answer: 4 },
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
        content: [{ type: 'text', text: '{"answer":4}' }],
      },
    ]);
    const out = await provider(sdk).generateStructured({
      model: 'claude-sonnet-5',
      schema,
      system: 'Tu es une calculatrice.',
      messages: [{ role: 'user', content: '2+2 ?' }],
      meta,
    });
    expect(out.data).toEqual({ answer: 4 });
    expect(out.raw).toBe('{"answer":4}');
    expect(out.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000 });

    const sent = sdk.calls[0]!;
    expect(sent.model).toBe('claude-sonnet-5');
    expect(sent.system).toBe('Tu es une calculatrice.');
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.output_config.format).toBeDefined();
    expect(sent.max_tokens).toBe(16000);

    expect(db!.select().from(apiCalls).get()).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      costUsd: 3,
      status: 'ok',
    });
  });

  it('signale une réponse tronquée ou refusée, et journalise l’échec', async () => {
    const truncated = fakeSdk([{ parsed_output: null, stop_reason: 'max_tokens', content: [] }]);
    await expect(
      provider(truncated).generateStructured({
        model: 'claude-sonnet-5',
        schema,
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        meta,
      }),
    ).rejects.toThrow(/tronquée/);
    expect(db!.select().from(apiCalls).get()?.status).toBe('error');

    const refused = fakeSdk([{ parsed_output: null, stop_reason: 'refusal', content: [] }]);
    await expect(
      provider(refused).generateStructured({
        model: 'claude-sonnet-5',
        schema,
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        meta,
      }),
    ).rejects.toThrow(AnthropicOutputError);
  });

  it('rejoue une erreur passagère (529 surcharge) puis réussit', async () => {
    let calls = 0;
    const sdk: AnthropicSdk = {
      messages: {
        parse: () => {
          calls++;
          return calls < 2
            ? Promise.reject(Object.assign(new Error('overloaded'), { status: 529 }))
            : Promise.resolve({ parsed_output: { answer: 1 }, stop_reason: 'end_turn' });
        },
      },
    };
    const out = await provider(sdk).generateStructured({
      model: 'claude-sonnet-5',
      schema,
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      meta,
    });
    expect(out.data.answer).toBe(1);
    expect(calls).toBe(2);
  });
});
