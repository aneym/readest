import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import { jsonSchema } from 'ai';
import { createTauriAdapter } from '@/services/ai/adapters/TauriChatAdapter';
import { ReedySourceStore } from '@/services/ai/adapters/reedySourceStore';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AIProviderName } from '@/services/ai/types';

/** Transport integration: real provider SDKs consume fake HTTP responses.
 * Guards silent SDK error events and server-message loss, not request call shapes.
 * Existing adapter wiring tests mock streamText and cannot exercise this failure.
 * No production-only testing seams are required.
 */
const fetchEdge = vi.fn<typeof fetch>();
const pairing = 'Pair this device with Homebase to use the assistant';

beforeEach(() => {
  vi.stubGlobal('fetch', fetchEdge);
  vi.stubEnv('HOMEBASE_API_BASE_URL', 'https://house.invalid/reader');
  localStorage.setItem('token', 'test-device-token');
  fetchEdge.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.removeItem('token');
});

async function run(provider: AIProviderName, reedy = false, signal = new AbortController().signal) {
  const adapter = createTauriAdapter(() => ({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider,
      openrouterApiKey: 'test-provider-key',
      aiGatewayApiKey: 'test-gateway-key',
    },
    bookHash: 'book',
    bookTitle: 'A book',
    authorName: '',
    currentPage: 1,
    sourceStore: new ReedySourceStore(),
    backend: {
      kind: reedy ? 'reedy' : 'legacy-idb',
      isIndexed: async () => false,
      indexBook: async () => {},
      clearBook: async () => {},
      ...(reedy
        ? {
            buildLookupTool: () => ({
              description: 'Lookup a passage',
              inputSchema: jsonSchema({ type: 'object', properties: {} }),
            }),
          }
        : {}),
    },
  }));
  const options = {
    messages: [
      {
        id: 'question',
        role: 'user',
        content: [{ type: 'text', text: 'Explain this' }],
        createdAt: new Date(),
        metadata: { custom: {} },
        attachments: [],
      },
    ],
    abortSignal: signal,
    runConfig: {},
    context: {},
    config: {},
  } as unknown as ChatModelRunOptions;
  const results: ChatModelRunResult[] = [];
  const output = adapter.run(options);
  if (Symbol.asyncIterator in output) {
    for await (const result of output) results.push(result);
  } else results.push(await output);
  return results;
}

function text(result: ChatModelRunResult | undefined) {
  return result?.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function stream(provider: AIProviderName, fail = false) {
  if (provider === 'ai-gateway') {
    // The web gateway route's contract is a plain UTF-8 text stream.
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Hello'));
        },
        pull(controller) {
          if (fail) controller.error(new Error('Stream disconnected'));
          else controller.close();
        },
      }),
    );
  }
  const payloads =
    provider === 'homebase'
      ? [
          {
            type: 'message_start',
            message: {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          ...(fail
            ? [
                {
                  type: 'error',
                  error: { type: 'overloaded_error', message: 'Provider overloaded' },
                },
              ]
            : [
                { type: 'content_block_stop', index: 0 },
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn', stop_sequence: null },
                  usage: { output_tokens: 1 },
                },
                { type: 'message_stop' },
              ]),
        ]
      : provider === 'ollama'
        ? [
            {
              model: 'llama3.2',
              created_at: '2026-10-05T00:00:00Z',
              message: { role: 'assistant', content: 'Hello' },
              done: false,
            },
            ...(fail
              ? [{ error: 'Provider overloaded' }]
              : [
                  {
                    model: 'llama3.2',
                    created_at: '2026-10-05T00:00:00Z',
                    message: { role: 'assistant', content: '' },
                    done: true,
                    done_reason: 'stop',
                    prompt_eval_count: 1,
                    eval_count: 1,
                  },
                ]),
          ]
        : [
            {
              id: 'chat',
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null },
              ],
            },
            ...(fail
              ? [{ error: { message: 'Provider overloaded', type: 'server_error' } }]
              : [{ id: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
          ];
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        // Model tokens arrive over time, not as one already-buffered body.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const part = payloads[index++];
        if (!part) {
          controller.close();
          return;
        }
        const wire =
          provider === 'ollama' ? `${JSON.stringify(part)}\n` : `data: ${JSON.stringify(part)}\n\n`;
        controller.enqueue(new TextEncoder().encode(wire));
      },
    }),
    {
      headers: {
        'Content-Type': provider === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
      },
    },
  );
}

for (const provider of ['homebase', 'openrouter', 'ollama', 'ai-gateway'] as const) {
  describe(provider, () => {
    it.each([
      JSON.stringify({ error: { message: pairing } }),
      JSON.stringify({ message: pairing }),
      pairing,
    ])('shows the HTTP error body %s', async (body) => {
      fetchEdge.mockImplementation(async () => new Response(body, { status: 403 }));
      const results = await run(provider);
      expect(text(results.at(-1))).toBe(pairing);
      expect(results.at(-1)?.status).toMatchObject({ type: 'incomplete', reason: 'error' });
    });
    it('shows network failure', async () => {
      fetchEdge.mockRejectedValue(new TypeError('Network unreachable'));
      expect(text((await run(provider)).at(-1))).toContain('Network unreachable');
    });
    it('shows mid-stream failure and keeps partial text', async () => {
      fetchEdge.mockImplementation(async () => stream(provider, true));
      const result = (await run(provider)).at(-1);
      expect(text(result)).toContain('Hello');
      expect(text(result)).toContain(
        provider === 'ai-gateway' ? 'Stream disconnected' : 'Provider overloaded',
      );
      expect(result?.status).toMatchObject({ reason: 'error' });
    });
    it('preserves normal stream text', async () => {
      fetchEdge.mockImplementation(async () => stream(provider));
      const result = (await run(provider)).at(-1);
      expect(text(result)).toBe('Hello');
      expect(result?.status).toBeUndefined();
    });
    it('never leaves an empty reply', async () => {
      fetchEdge.mockImplementation(
        async () => new Response('', { headers: { 'Content-Type': 'text/event-stream' } }),
      );
      expect(text((await run(provider)).at(-1))).toBeTruthy();
    });
  });
}

it('surfaces errors in the Reedy tool-enabled SDK path', async () => {
  fetchEdge.mockImplementation(async () => stream('homebase', true));
  expect(text((await run('homebase', true)).at(-1))).toContain('Provider overloaded');
});
it('shows local Homebase pairing failure', async () => {
  localStorage.removeItem('token');
  expect(text((await run('homebase')).at(-1))).toBe(pairing);
});
it('redacts keys and authorization headers from error text', async () => {
  fetchEdge.mockImplementation(
    async () =>
      new Response('Denied test-provider-key\nAuthorization: Bearer test-device-token', {
        status: 403,
      }),
  );
  const result = text((await run('openrouter')).at(-1));
  expect(result).toContain('Denied');
  expect(result).not.toContain('test-provider-key');
  expect(result).not.toContain('test-device-token');
  expect(result).not.toContain('Authorization');
});
it('does not turn user cancellation into an error reply', async () => {
  const controller = new AbortController();
  controller.abort();
  fetchEdge.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  expect(await run('ai-gateway', false, controller.signal)).toEqual([]);
});

// Reedy bypasses the browser text proxy and uses the gateway SDK directly.
function directGatewayStream(fail: boolean) {
  const events = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'Hello' },
    ...(fail
      ? [{ type: 'error', error: { message: 'Provider overloaded' } }]
      : [
          { type: 'text-end', id: 'text' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]),
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('direct gateway (Reedy)', () => {
  it.each([
    JSON.stringify({ error: { message: pairing } }),
    JSON.stringify({ message: pairing }),
    pairing,
  ])('shows HTTP body %s', async (body) => {
    fetchEdge.mockImplementation(async () => new Response(body, { status: 403 }));
    expect(text((await run('ai-gateway', true)).at(-1))).toBe(pairing);
  });
  it('shows network errors', async () => {
    fetchEdge.mockRejectedValue(new TypeError('Network unreachable'));
    expect(text((await run('ai-gateway', true)).at(-1))).toContain('Network unreachable');
  });
  it('surfaces error events', async () => {
    fetchEdge.mockImplementation(async () => directGatewayStream(true));
    const result = (await run('ai-gateway', true)).at(-1);
    expect(text(result)).toBe('Hello\n\nProvider overloaded');
    expect(result?.status).toMatchObject({ reason: 'error' });
  });
  it('preserves normal output', async () => {
    fetchEdge.mockImplementation(async () => directGatewayStream(false));
    expect(text((await run('ai-gateway', true)).at(-1))).toBe('Hello');
  });
});
