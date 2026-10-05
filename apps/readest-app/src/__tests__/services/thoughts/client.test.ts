import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { encodeWav } from '@/services/thoughts/wavRecorder';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  captureThought,
  captureVoice,
  flushThoughtsQueue,
  watchThoughtsQueue,
} from '@/services/thoughts/client';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/household', () => ({ isHouseholdBuild: () => true }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));
const http = vi.mocked(tauriFetch);
const reply = (id: string) =>
  new Response(JSON.stringify({ ok: true, thought: { captureId: id } }));
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-device-token');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  http.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Thoughts device client', () => {
  test('posts exact server body at the host origin with device headers', async () => {
    http.mockResolvedValue(reply('thought-1'));
    expect(
      await captureThought({
        body: 'Keep this exactly.\n',
        captureId: 'thought-1',
        capturedAt: 123,
      }),
    ).toEqual({ ok: true, id: 'thought-1' });
    const [url, request] = http.mock.calls[0]!;
    expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts');
    expect(JSON.parse(String(request?.body))).toEqual({
      body: 'Keep this exactly.\n',
      captureId: 'thought-1',
      capturedAt: 123,
    });
    expect(request?.headers).toEqual({
      Authorization: 'Bearer test-device-token',
      Accept: 'application/json',
      Origin: 'https://studio.tailf266ac.ts.net',
      'X-Homebase-Media-Action': '1',
      'Content-Type': 'application/json',
    });
    expect(request?.method).toBe('POST');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });
  test('unpaired makes no request and retains no offline capture', async () => {
    localStorage.removeItem('token');
    expect(await captureThought({ body: 'Hello' })).toEqual({ ok: false, reason: 'unpaired' });
    expect(http).not.toHaveBeenCalled();
    expect(localStorage.getItem('homebase-thoughts-pending-v1')).toBeNull();
  });
  test('offline persists and reconnect flushes without changing id or timestamp', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const stop = watchThoughtsQueue();
    await flushThoughtsQueue();
    const input = { body: 'Offline thought', captureId: 'offline-1', capturedAt: 200 };
    expect(await captureThought(input)).toEqual({ ok: false, reason: 'offline' });
    expect(http).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('homebase-thoughts-pending-v1')!)).toEqual([input]);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    http.mockResolvedValue(reply('offline-1'));
    window.dispatchEvent(new Event('online'));
    await flushThoughtsQueue();
    expect(JSON.parse(String(http.mock.calls[0]![1]?.body))).toEqual(input);
    expect(JSON.parse(localStorage.getItem('homebase-thoughts-pending-v1')!)).toEqual([]);
    stop();
  });
  test('network rejection queues but HTTP errors do not pretend to save offline', async () => {
    http.mockRejectedValueOnce(new TypeError('network'));
    expect(await captureThought({ body: 'Later', captureId: 'retry' })).toEqual({
      ok: false,
      reason: 'offline',
    });
    http.mockResolvedValueOnce(new Response('', { status: 503 }));
    await flushThoughtsQueue();
    expect(JSON.parse(localStorage.getItem('homebase-thoughts-pending-v1')!)).toHaveLength(1);
    http.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect(await captureThought({ body: 'Refused' })).toEqual({ ok: false, reason: 'unpaired' });
  });
  test('voice uses raw audio and required intent and recorded-at headers', async () => {
    http.mockResolvedValue(
      new Response(JSON.stringify({ thought: { captureId: 'voice-1', body: 'Spoken thought' } })),
    );
    const audio = new Blob([encodeWav([new Float32Array(1600)], 16000)], { type: 'audio/wav' });
    expect(await captureVoice(audio, 'voice-1')).toEqual({
      ok: true,
      id: 'voice-1',
      transcript: 'Spoken thought',
    });
    expect(http.mock.calls[0]![0]).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts/voice');
    expect(http.mock.calls[0]![1]?.body).toBe(audio);
    expect(http.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer test-device-token',
      'Content-Type': 'audio/wav',
      'X-Intent-Id': 'voice-1',
      'X-Recorded-At': expect.any(String),
    });
  });
});
