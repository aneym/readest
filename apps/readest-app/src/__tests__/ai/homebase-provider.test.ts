import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamText } from 'ai';
import { getAIProvider } from '@/services/ai/providers';
import { ReedyBackend } from '@/services/ai/adapters/ReedyBackend';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AISettings } from '@/services/ai/types';
import type { AppService } from '@/types/system';

// Integration: the Homebase provider against a real HTTP server standing in
// for the household route. Guards what the Palma depends on: the Anthropic
// Messages call lands on <base>/ai/v1/messages with the paired token and no
// provider key, the streamed answer comes back, and mounting the AI tab
// (which builds the retrieval backend and its embedding model) does not throw.
const seen: Array<{ url?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> =
  [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'About lying.' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
  event('message_stop', {});
  res.end();
});
const settings: AISettings = { ...DEFAULT_AI_SETTINGS, enabled: true, provider: 'homebase' };

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv('NEXT_PUBLIC_HOMEBASE_API_BASE_URL', `http://127.0.0.1:${port}/api/readest`);
  localStorage.setItem('token', 'paired-device-token');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  localStorage.removeItem('token');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Homebase AI provider', () => {
  it('streams an answer from the household route with the paired token', async () => {
    const result = streamText({
      model: getAIProvider(settings).getModel(),
      system: 'You are a reading assistant.',
      messages: [{ role: 'user', content: 'What is this page about?' }],
    });
    let text = '';
    for await (const chunk of result.textStream) text += chunk;

    expect(text).toBe('About lying.');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/api/readest/ai/v1/messages');
    expect(seen[0]!.headers.authorization).toBe('Bearer paired-device-token');
    expect(seen[0]!.headers['x-api-key']).toBeUndefined();
    expect(seen[0]!.body['stream']).toBe(true);
  });

  it('builds on an unpaired device and fails only when asked', async () => {
    localStorage.removeItem('token');
    const before = seen.length;
    try {
      const appService = { openDatabase: () => new Promise(() => {}) } as unknown as AppService;
      expect(() => new ReedyBackend(appService, settings)).not.toThrow();
      const result = streamText({
        model: getAIProvider(settings).getModel(),
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const errors: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'error') errors.push((part.error as Error).message);
      }
      expect(errors).toEqual(['Pair this device with Homebase to use the assistant']);
      expect(seen).toHaveLength(before);
    } finally {
      localStorage.setItem('token', 'paired-device-token');
    }
  });

  it('lets the AI tab build its retrieval backend; only embedding itself fails', async () => {
    const appService = { openDatabase: () => new Promise(() => {}) } as unknown as AppService;
    expect(() => new ReedyBackend(appService, settings)).not.toThrow();
    const model = getAIProvider(settings).getEmbeddingModel();
    if (typeof model === 'string') throw new Error('expected a model object');
    await expect(model.doEmbed({ values: ['x'] })).rejects.toThrow(
      'Homebase does not serve embeddings',
    );
  });
});
