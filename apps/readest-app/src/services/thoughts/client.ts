import { queueVoice, readVoiceQueue, removeVoice } from './voiceQueue';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { isHouseholdBuild } from '@/services/household';
import { getHomebaseBaseUrl } from '@/services/sync/homebase/config';

export type ThoughtsResult =
  | { ok: true; id: string; transcript?: string }
  | { ok: false; reason: 'offline' | 'unpaired' | 'error'; queued?: boolean };

export interface ThoughtInput {
  body: string;
  captureId?: string;
  capturedAt?: number;
}
interface PendingThought {
  attempts?: number;
  body: string;
  captureId: string;
  capturedAt: number;
}
const QUEUE_KEY = 'homebase-thoughts-pending-v1';
export const THOUGHTS_TIMEOUT_MS = 10_000;

/** Single seam for the household reader-device authorization contract. */
export function thoughtsAuthHeaders(): Record<string, string> | null {
  const token = localStorage.getItem('token');
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-Homebase-Media-Action': '1',
    Origin: 'https://studio.tailf266ac.ts.net',
  };
}

function readQueue(): PendingThought[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.filter(
      (item): item is PendingThought =>
        !!item &&
        typeof item.body === 'string' &&
        typeof item.captureId === 'string' &&
        typeof item.capturedAt === 'number',
    );
  } catch {
    return [];
  }
}
function queue(input: PendingThought): boolean {
  try {
    const pending = readQueue().filter((item) => item.captureId !== input.captureId);
    localStorage.setItem(QUEUE_KEY, JSON.stringify([...pending, input]));
    return true;
  } catch {
    return false;
  }
}
async function send(
  path: string,
  body: BodyInit,
  extraHeaders: Record<string, string>,
): Promise<ThoughtsResult> {
  if (!isHouseholdBuild()) return { ok: false, reason: 'error' };
  const headers = thoughtsAuthHeaders();
  const base = getHomebaseBaseUrl();
  if (!headers || !base) return { ok: false, reason: 'unpaired' };
  if (navigator.onLine === false) return { ok: false, reason: 'offline' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THOUGHTS_TIMEOUT_MS);
  try {
    const response = await (isTauriAppPlatform() ? tauriFetch : globalThis.fetch)(
      `${new URL(base).origin}/api/thoughts${path}`,
      { method: 'POST', headers: { ...headers, ...extraHeaders }, body, signal: controller.signal },
    );
    if (response.status === 401 || response.status === 403)
      return { ok: false, reason: 'unpaired' };
    // A 4xx means Homebase refused this exact capture; retrying won't help. A 5xx is an
    // outage, so the capture waits like an offline one.
    if (response.status >= 400 && response.status < 500 && response.status !== 429)
      return { ok: false, reason: 'error' };
    if (!response.ok) return { ok: false, reason: 'offline' };
    const data: unknown = await response.json();
    if (
      data &&
      typeof data === 'object' &&
      'thought' in data &&
      data.thought &&
      typeof data.thought === 'object' &&
      'captureId' in data.thought &&
      typeof data.thought.captureId === 'string'
    )
      return {
        ok: true,
        id: data.thought.captureId,
        ...(path === '/voice' && 'body' in data.thought && typeof data.thought.body === 'string'
          ? { transcript: data.thought.body }
          : {}),
      };
    // No acknowledgement: send again later. Homebase dedupes on captureId.
    return { ok: false, reason: 'offline' };
  } catch {
    return { ok: false, reason: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
export async function captureThought(input: ThoughtInput): Promise<ThoughtsResult> {
  if (!input.body.trim() || input.body.length > 20_000) return { ok: false, reason: 'error' };
  const pending: PendingThought = {
    body: input.body,
    captureId: input.captureId ?? crypto.randomUUID(),
    capturedAt: input.capturedAt ?? Date.now(),
  };
  const result = await send('', JSON.stringify(pending), { 'Content-Type': 'application/json' });
  // Keep the capture through an outage or a rejected token; a device that was never paired has
  // nowhere to send it.
  const keep =
    !result.ok &&
    (result.reason === 'offline' || (result.reason === 'unpaired' && !!thoughtsAuthHeaders()));
  if (keep && !queue(pending)) return { ok: false, reason: 'error' };
  return result;
}

/** The current server accepts raw AAC/MP4 or WAV, not multipart or WebM. */
export async function captureVoice(
  audio: Blob,
  id = crypto.randomUUID(),
  recordedAt = new Date().toISOString(),
): Promise<ThoughtsResult> {
  if (audio.type !== 'audio/wav' || audio.size < 256 || audio.size > 32 * 1024 * 1024)
    return { ok: false, reason: 'error' };
  const result = await send('/voice', audio, {
    'Content-Type': audio.type,
    'X-Intent-Id': id,
    'X-Recorded-At': recordedAt,
  });
  if (!result.ok && result.reason === 'offline')
    return { ...result, queued: await queueVoice({ audio, id, recordedAt }) };
  if (result.ok) await removeVoice(id).catch(() => {});
  return result;
}
let flushing: Promise<void> | null = null;
export function flushThoughtsQueue(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const item of readQueue()) {
      const { attempts: _attempts, ...thought } = item;
      const result = await send('', JSON.stringify(thought), {
        'Content-Type': 'application/json',
      });
      // Offline, an outage or a lost pairing: keep everything and try again later.
      if (!result.ok && result.reason !== 'error') break;
      const attempts = (item.attempts ?? 0) + 1;
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify(
          readQueue().flatMap((entry) =>
            entry.captureId !== item.captureId
              ? [entry]
              : !result.ok && attempts < 5
                ? [{ ...entry, attempts }]
                : [],
          ),
        ),
      );
    }
    for (const take of await readVoiceQueue().catch(() => [])) {
      const result = await send('/voice', take.audio, {
        'Content-Type': 'audio/wav',
        'X-Intent-Id': take.id,
        'X-Recorded-At': take.recordedAt,
      });
      if (!result.ok) break;
      await removeVoice(take.id);
    }
  })()
    .catch(() => {})
    .finally(() => {
      flushing = null;
    });
  return flushing;
}
export function watchThoughtsQueue(): () => void {
  const flush = () => {
    void flushThoughtsQueue();
  };
  const resume = () => {
    if (document.visibilityState === 'visible') flush();
  };
  window.addEventListener('online', flush);
  window.addEventListener('focus', flush);
  document.addEventListener('visibilitychange', resume);
  flush();
  return () => {
    window.removeEventListener('online', flush);
    window.removeEventListener('focus', flush);
    document.removeEventListener('visibilitychange', resume);
  };
}

export const postThought = captureThought;
export const postVoiceThought = captureVoice;
