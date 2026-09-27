import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';

/**
 * Household boot stays on the tailnet: opening the app or a book must not
 * reach Google Fonts, the Readest CDNs, PostHog or Supabase, and an offline
 * boot must not touch the network or nag. Everything here goes through the
 * same entry points the app calls at boot: mountAdditionalFonts (Reader and
 * FoliateViewer), the diagnostics reporter (Providers), the manual library
 * sync toast (useBooksSync) and AuthProvider with the shared Supabase client.
 */

const household = vi.hoisted(() => ({ value: true }));
vi.mock('@/services/household', () => ({ isHouseholdBuild: () => household.value }));

const HOMEBASE_BASE = 'https://homebase.test/api/readest';
const FORBIDDEN = /readest\.com|posthog|supabase|googleapis|gstatic|jsdelivr|cdnjs|onlinewebfonts/i;

const { mountAdditionalFonts } = await import('@/styles/fonts');
const { getHomebaseBaseUrl } = await import('@/services/sync/homebase/config');
const { flushDiagnostics, recordDiagnostic, startDiagnosticsReporter, DIAGNOSTICS_TIMEOUT_MS } =
  await import('@/services/sync/homebase/diagnostics');

let requested: string[] = [];

const urlsIn = (node: Node): string[] => {
  if (node instanceof HTMLLinkElement) return [node.href];
  if (node instanceof HTMLScriptElement) return node.src ? [node.src] : [];
  if (node instanceof HTMLStyleElement) {
    return Array.from((node.textContent ?? '').matchAll(/url\(\s*["']?(https?:[^"')]+)/g)).map(
      (m) => m[1]!,
    );
  }
  return [];
};

const remoteHosts = () =>
  requested.filter((url) => /^https?:/.test(url)).map((url) => new URL(url).host);

const setOnline = (online: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);

beforeEach(() => {
  household.value = true;
  requested = [];
  document.head.innerHTML = '';
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_HOMEBASE_API_BASE_URL', HOMEBASE_BASE);
  vi.stubEnv('NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED', '1');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return new Response('{"ok":true}', { status: 200 });
  });
  const open = XMLHttpRequest.prototype.open as (method: string, url: string | URL) => void;
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
  ) {
    requested.push(String(url));
    open.call(this, method, url);
  });
  const appendChild = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    requested.push(...urlsIn(node));
    return appendChild(node);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('household boot fonts', () => {
  it('mounts no remote stylesheet or font file for Latin or CJK books', async () => {
    await mountAdditionalFonts(document);
    await mountAdditionalFonts(document, true);

    expect(remoteHosts()).toEqual([]);
    expect(document.head.querySelectorAll('link').length).toBe(0);
    // CJK books still get the local() aliases for FangSong, Kaiti and friends.
    expect(document.head.querySelector('style')?.textContent).toContain('local("FangSong")');
  });

  it('keeps the remote font path outside household builds', async () => {
    household.value = false;

    await mountAdditionalFonts(document);

    expect(remoteHosts()).toContain('fonts.googleapis.com');
  });
});

describe('household boot diagnostics', () => {
  const deps = { clientId: 'client-1', getToken: vi.fn(async () => 'device-token') };

  it('does not touch the network while offline', async () => {
    setOnline(false);
    recordDiagnostic('app.start', 'info', 'app started');

    const stop = startDiagnosticsReporter(deps);
    try {
      expect(await flushDiagnostics(deps)).toBe(0);
    } finally {
      stop();
    }

    expect(requested).toEqual([]);
    expect(deps.getToken).not.toHaveBeenCalled();
  });

  it('online, posts only to the configured Homebase host', async () => {
    setOnline(true);
    recordDiagnostic('app.start', 'info', 'app started');

    expect(await flushDiagnostics(deps)).toBe(1);

    const homebaseHost = new URL(getHomebaseBaseUrl()!).host;
    expect(remoteHosts()).toEqual([homebaseHost]);
    expect(requested.some((url) => FORBIDDEN.test(url))).toBe(false);
  });

  it('gives up on a hung Homebase within the timeout instead of blocking', async () => {
    vi.useFakeTimers();
    setOnline(true);
    recordDiagnostic('app.start', 'info', 'app started');
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const flushed = flushDiagnostics(deps);
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_TIMEOUT_MS);

    await expect(flushed).resolves.toBe(0);
  });

  it('never throws into its caller when storage access is denied', async () => {
    setOnline(true);
    recordDiagnostic('app.start', 'info', 'app started');
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    await expect(flushDiagnostics(deps)).resolves.toBe(0);
    expect(requested).toEqual([]);
  });
});

// ---- Manual library sync toast ----

const routing = vi.hoisted(() => ({
  backends: ['webdav'] as string[],
  fileResult: null as { booksSynced: number } | null,
  passError: null as string | null,
}));

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({
    useSyncInited: false,
    syncedBooks: null,
    syncBooks: vi.fn(async () => 0),
    lastSyncedAtBooks: 0,
  }),
}));
vi.mock('@/services/sync/cloudSyncProvider', () => ({
  isReadestCloudEnabled: () => false,
  getActiveFileSyncBackends: () => routing.backends,
}));
// Like the real pass: every backend it runs gets an entry, null or a message.
vi.mock('@/services/sync/file/runLibrarySync', async () => {
  const { useFileSyncStore } = await import('@/store/fileSyncStore');
  return {
    runFileLibrarySyncPass: vi.fn(async () => {
      for (const kind of routing.backends) {
        useFileSyncStore.getState().setLastError(kind as 'webdav', routing.passError);
      }
      return routing.fileResult;
    }),
  };
});

const { useBooksSync } = await import('@/app/library/hooks/useBooksSync');
const { useFileSyncStore } = await import('@/store/fileSyncStore');
const { useLibraryStore } = await import('@/store/libraryStore');
const { eventDispatcher } = await import('@/utils/event');

describe('manual library sync toast', () => {
  const pullManually = async () => {
    const toasts: unknown[] = [];
    const onToast = (event: CustomEvent) => {
      toasts.push(event.detail);
    };
    eventDispatcher.on('toast', onToast);
    const { result } = renderHook(() => useBooksSync());
    await act(() => result.current.pullLibrary(false, true));
    eventDispatcher.off('toast', onToast);
    return toasts;
  };

  beforeEach(() => {
    routing.fileResult = null;
    routing.passError = null;
    useLibraryStore.setState({ library: [], libraryLoaded: true, isSyncing: false });
    useFileSyncStore.setState({ lastErrorByKind: {} });
  });

  it.each([
    ['the device is offline', false, 'HTTP 500'],
    ['the only failure is a network error', true, 'Failed to fetch'],
    ['WebDAV times out while online', true, 'Request timed out'],
  ])('stays quiet when %s', async (_label, online, error) => {
    setOnline(online);
    routing.passError = error;

    expect(await pullManually()).toEqual([]);
  });

  it('judges only this sync, not a stale error from a disabled backend', async () => {
    setOnline(true);
    useFileSyncStore.setState({ lastErrorByKind: { gdrive: 'Failed to fetch file size: 500' } });
    routing.passError = 'Failed to fetch';

    expect(await pullManually()).toEqual([]);
  });

  it('still reports a real server failure online', async () => {
    setOnline(true);
    routing.passError = 'Failed to fetch file size: 500';

    expect(await pullManually()).toEqual([{ type: 'error', message: 'Sync failed' }]);
  });

  it('keeps the failure toast outside household builds', async () => {
    household.value = false;
    setOnline(false);
    routing.passError = 'Request timed out';

    expect(await pullManually()).toEqual([{ type: 'error', message: 'Sync failed' }]);
  });

  it('keeps the success toast offline', async () => {
    setOnline(false);
    routing.fileResult = { booksSynced: 2 };

    expect(await pullManually()).toEqual([{ type: 'info', message: '{{count}} book(s) synced' }]);
  });
});

// ---- Auth: the shared Supabase client ----

describe('household boot auth', () => {
  const SUPABASE_HOST = 'boot-test.supabase.co';

  // An expired session persisted by an older, signed-in install: on
  // construction the Supabase client would try to refresh it over the network.
  const bootAuthProvider = async () => {
    window.__READEST_RUNTIME_CONFIG = {
      supabaseUrl: `https://${SUPABASE_HOST}`,
      supabaseAnonKey: 'anon-key',
    };
    localStorage.setItem(
      'sb-boot-test-auth-token',
      JSON.stringify({
        access_token: 'expired-access',
        refresh_token: 'stale-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 3600,
        user: { id: 'user-1' },
      }),
    );
    vi.resetModules();
    const { AuthProvider } =
      await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
    render(
      <AuthProvider>
        <span />
      </AuthProvider>,
    );
    const { supabase } = await import('@/utils/supabase');
    await supabase.auth.getSession();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  afterEach(() => {
    delete window.__READEST_RUNTIME_CONFIG;
  });

  it('makes no Supabase call while restoring a persisted session', async () => {
    await bootAuthProvider();

    expect(remoteHosts()).not.toContain(SUPABASE_HOST);
    expect(requested.some((url) => FORBIDDEN.test(url))).toBe(false);
  });

  it('still refreshes the persisted session outside household builds', async () => {
    household.value = false;

    await bootAuthProvider();

    expect(remoteHosts()).toContain(SUPABASE_HOST);
  });
});
