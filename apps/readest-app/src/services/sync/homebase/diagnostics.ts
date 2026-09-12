/**
 * Household diagnostics: a small, durable event log the fork ships to the
 * Homebase server so a reconnecting operator can see what the reader did
 * while it was out of reach (theme schedule transitions, sync failures,
 * unhandled errors, app starts with the build that produced them).
 *
 * Events are appended to a localStorage ring buffer synchronously — the
 * write path never awaits — and flushed in batches to
 * `{base}/reader/diagnostics` with the paired device token. A failed flush
 * keeps the batch; a 2xx drops exactly the events that were sent. Nothing
 * here runs unless Homebase sync is configured and enabled, and no event
 * carries book text, positions, or credentials.
 */

import { getHomebaseBaseUrl, isHomebaseSyncEnabled } from './config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_HOMEBASE_BUILD_ID?: string;
      NEXT_PUBLIC_APP_PLATFORM?: string;
    }
  }
}

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  /** Monotonic per-install sequence; the server dedupes on (clientId, seq). */
  seq: number;
  /** Device wall clock, ms since epoch. */
  ts: number;
  /** Local wall clock as the device saw it, for schedule debugging. */
  local: string;
  kind: string;
  level: DiagnosticLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticsBatch {
  clientId: string;
  app: { build: string; platform: string };
  events: DiagnosticEvent[];
}

export const DIAGNOSTICS_STORAGE_KEY = 'readest-homebase-diagnostics';
export const DIAGNOSTICS_SEQ_KEY = 'readest-homebase-diagnostics-seq';
export const DIAGNOSTICS_PATH = '/reader/diagnostics';
/** Ring buffer cap; oldest events drop first so storage stays bounded. */
export const DIAGNOSTICS_MAX_EVENTS = 300;
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 60_000;
/** Cap per POST so a long-offline backlog still fits one request. */
export const DIAGNOSTICS_BATCH_SIZE = 100;

const hasStorage = () => typeof window !== 'undefined' && !!window.localStorage;

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS" in the device's local timezone. */
export const formatLocalClock = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

export const readDiagnosticEvents = (): DiagnosticEvent[] => {
  if (!hasStorage()) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as DiagnosticEvent[]) : [];
  } catch {
    return [];
  }
};

const writeDiagnosticEvents = (events: DiagnosticEvent[]) => {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Quota or private mode: diagnostics are best-effort by design.
  }
};

const nextSeq = (): number => {
  if (!hasStorage()) return Date.now();
  const seq = Number(localStorage.getItem(DIAGNOSTICS_SEQ_KEY) ?? '0') + 1;
  localStorage.setItem(DIAGNOSTICS_SEQ_KEY, String(seq));
  return seq;
};

/** Listeners fire after an event is stored, so the reporter can flush early. */
const listeners = new Set<(event: DiagnosticEvent) => void>();

/**
 * Append one event. Safe to call from anywhere, including before the
 * reporter starts and when Homebase is unconfigured (the buffer just stays
 * local). Never throws.
 */
export const recordDiagnostic = (
  kind: string,
  level: DiagnosticLevel,
  message: string,
  data?: Record<string, unknown>,
): DiagnosticEvent | null => {
  try {
    const now = new Date();
    const event: DiagnosticEvent = {
      seq: nextSeq(),
      ts: now.getTime(),
      local: formatLocalClock(now),
      kind,
      level,
      message,
      ...(data ? { data } : {}),
    };
    const events = readDiagnosticEvents();
    events.push(event);
    if (events.length > DIAGNOSTICS_MAX_EVENTS) {
      events.splice(0, events.length - DIAGNOSTICS_MAX_EVENTS);
    }
    writeDiagnosticEvents(events);
    listeners.forEach((listener) => listener(event));
    return event;
  } catch {
    return null;
  }
};

export const getAppBuildInfo = (): DiagnosticsBatch['app'] => ({
  // Dot notation is load-bearing: Next only inlines literal member access.
  // The build id is "<version>+<fork sha>", stamped by scripts/household-build.sh.
  build: process.env.NEXT_PUBLIC_HOMEBASE_BUILD_ID || 'unknown',
  platform: process.env.NEXT_PUBLIC_APP_PLATFORM || 'web',
});

export interface DiagnosticsReporterDeps {
  clientId: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** Injectable for tests; defaults to the real window. */
  target?: Pick<
    Window,
    'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'
  > & {
    document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  };
}

/**
 * Send pending events once. Resolves to the number of events the server
 * accepted; 0 when nothing was pending, Homebase is off, the device is not
 * paired, or the request failed (the batch is kept for the next attempt).
 */
export const flushDiagnostics = async (deps: DiagnosticsReporterDeps): Promise<number> => {
  if (!isHomebaseSyncEnabled()) return 0;
  const base = getHomebaseBaseUrl();
  if (!base) return 0;
  const pending = readDiagnosticEvents();
  if (pending.length === 0) return 0;
  const token = await deps.getToken();
  if (!token) return 0;
  const batch = pending.slice(0, DIAGNOSTICS_BATCH_SIZE);
  const body: DiagnosticsBatch = { clientId: deps.clientId, app: getAppBuildInfo(), events: batch };
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    const response = await fetchImpl(`${base}${DIAGNOSTICS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Homebase-Client': deps.clientId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return 0;
  } catch {
    return 0;
  }
  // Re-read: events recorded during the request must survive the trim.
  const lastSent = batch[batch.length - 1]!.seq;
  writeDiagnosticEvents(readDiagnosticEvents().filter((event) => event.seq > lastSent));
  return batch.length;
};

/**
 * Start the background reporter: flush now, on an interval, whenever the app
 * comes back to the foreground, and shortly after any warn/error event.
 * Also captures unhandled errors and promise rejections. Returns a stop
 * function. Calling it twice is a no-op until stopped.
 */
let reporterActive = false;

export const startDiagnosticsReporter = (deps: DiagnosticsReporterDeps): (() => void) => {
  if (reporterActive || typeof window === 'undefined') return () => {};
  reporterActive = true;
  const target = deps.target ?? window;
  const doc = deps.target?.document ?? document;
  const flush = () => void flushDiagnostics(deps);

  const onVisibility = () => {
    if (doc.visibilityState === 'visible') flush();
  };
  const onError = (event: ErrorEvent) => {
    recordDiagnostic('error.unhandled', 'error', String(event.message ?? 'error'), {
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    recordDiagnostic('error.unhandledrejection', 'error', message);
  };
  let urgent: ReturnType<typeof setTimeout> | null = null;
  const onEvent = (event: DiagnosticEvent) => {
    if (event.level === 'info' || urgent) return;
    urgent = setTimeout(() => {
      urgent = null;
      flush();
    }, 2_000);
  };

  const interval = target.setInterval(flush, deps.intervalMs ?? DIAGNOSTICS_FLUSH_INTERVAL_MS);
  doc.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  listeners.add(onEvent);
  flush();

  return () => {
    reporterActive = false;
    target.clearInterval(interval);
    doc.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
    listeners.delete(onEvent);
    if (urgent) clearTimeout(urgent);
  };
};
