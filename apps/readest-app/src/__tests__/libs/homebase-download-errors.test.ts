import { afterEach, expect, it, vi } from 'vitest';
import { downloadFile } from '@/libs/storage';
import { getBookDownloadFailureMessage } from '@/services/bookDownloadErrors';
import { stubTranslation } from '@/utils/misc';

// Integration at the HTTP boundary: no storage/transfer collaborators mocked.
// Replays the household gate response and common storage failures; the old
// code lost the server code and both manual/queued toast paths hid the reason.
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__READEST_RUNTIME_CONFIG;
});

it.each([
  [403, 'MEDIA_TAILNET_ONLY', 'Connect to the household network or Tailscale'],
  [401, 'UNAUTHORIZED', 'Pair this device with Homebase again'],
  [
    404,
    'FILE_NOT_FOUND',
    'Refresh the library; if it still fails, restore the book file on Homebase',
  ],
  [500, 'INTERNAL_ERROR', 'Homebase could not serve this book. Try again'],
  [504, 'TIMEOUT', 'Homebase took too long. Check the connection and try again'],
])('preserves actionable download reason for HTTP %s', async (status, code, action) => {
  window.__READEST_RUNTIME_CONFIG = {
    homebaseApiBaseUrl: 'http://household.test/api/readest',
    homebaseSyncEnabled: true,
  };
  let requested = '';
  vi.stubGlobal('fetch', async (url: string) => {
    requested = url;
    return new Response(JSON.stringify({ ok: false, code, error: 'not shown verbatim' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  let failure: unknown;
  try {
    await downloadFile({
      // The rejected URL lookup must stop before accessing the filesystem.
      appService: null!,
      dst: 'book.epub',
      cfp: 'books/d080997f588378e47c090f50c5148c72/Before They Are Hanged.epub',
    });
  } catch (error) {
    failure = error;
  }
  expect(requested).toBe(
    'http://household.test/api/readest/reader/storage/download?fileKey=d080997f588378e47c090f50c5148c72.epub',
  );
  expect(
    getBookDownloadFailureMessage(failure, 'Before They Are Hanged', stubTranslation),
  ).toContain(action);
  // Queue persistence serializes errors as strings, while manual opens use Errors.
  expect(
    getBookDownloadFailureMessage(String(failure), 'Before They Are Hanged', stubTranslation),
  ).toContain(action);
});
