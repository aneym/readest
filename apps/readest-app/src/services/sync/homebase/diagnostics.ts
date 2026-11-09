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
  seq: number;
  ts: number;
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
export const DIAGNOSTICS_MAX_EVENTS = 300;
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 60_000;
export const DIAGNOSTICS_BATCH_SIZE = 100;
export const DIAGNOSTICS_TIMEOUT_MS = 5_000;

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const hasStorage = () => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
};

const pad = (n: number) => String(n).padStart(2, '0');

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
  } catch {}
};

const nextSeq = (): number => {
  if (!hasStorage()) return Date.now();
  const seq = Number(localStorage.getItem(DIAGNOSTICS_SEQ_KEY) ?? '0') + 1;
  localStorage.setItem(DIAGNOSTICS_SEQ_KEY, String(seq));
  return seq;
};

const listeners = new Set<(event: DiagnosticEvent) => void>();

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
  build: process.env.NEXT_PUBLIC_HOMEBASE_BUILD_ID || 'unknown',
  platform: process.env.NEXT_PUBLIC_APP_PLATFORM || 'web',
});

export interface DiagnosticsReporterDeps {
  clientId: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  target?: Pick<
    Window,
    'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'
  > & {
    document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  };
}

export const flushDiagnostics = async (deps: DiagnosticsReporterDeps): Promise<number> => {
  if (isOffline()) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!isHomebaseSyncEnabled()) return 0;
    const base = getHomebaseBaseUrl();
    if (!base) return 0;
    const pending = readDiagnosticEvents();
    if (pending.length === 0) return 0;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    timer = setTimeout(() => controller?.abort(), DIAGNOSTICS_TIMEOUT_MS);
    const token = await deps.getToken();
    if (!token) return 0;
    const batch = pending.slice(0, DIAGNOSTICS_BATCH_SIZE);
    const body: DiagnosticsBatch = {
      clientId: deps.clientId,
      app: getAppBuildInfo(),
      events: batch,
    };
    const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const response = await fetchImpl(`${base}${DIAGNOSTICS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Homebase-Client': deps.clientId,
      },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return 0;
    const lastSent = batch[batch.length - 1]!.seq;
    writeDiagnosticEvents(readDiagnosticEvents().filter((event) => event.seq > lastSent));
    return batch.length;
  } catch {
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
