import type { TranslationFunc } from '@/hooks/useTranslation';

// Stable, secret-free marker survives transfer queue persistence as a string.
export const homebaseDownloadError = (status: number, code: string): Error =>
  new Error(
    `Homebase book download failed (${status}; ${code})${
      status === 404 || status === 410 ? '. Refresh the library to download this book' : ''
    }`,
  );

// Include the previous build's persisted error so upgrading stops existing loops.
export const isMissingHomebaseBookError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /^Homebase book download failed \((404|410); [A-Z_]+\)/.test(message) ||
    /^Homebase download URL failed: (404|410)$/.test(message)
  );
};

export const getBookDownloadFailureMessage = (
  error: unknown,
  title: string,
  _: TranslationFunc,
): string => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /Homebase book download failed \((\d+); ([A-Z_]+)\)/.exec(message);
  if (!match) return _('Failed to download book: {{title}}', { title });
  const status = Number(match[1]);
  if (match[2] === 'MEDIA_TAILNET_ONLY')
    return _('Connect to the household network or Tailscale to download {{title}}', { title });
  if (status === 401 || status === 403)
    return _('Pair this device with Homebase again to download {{title}}', { title });
  if (status === 404 || status === 409 || status === 410)
    return _(
      'Homebase cannot find {{title}}. Refresh the library; if it still fails, restore the book file on Homebase',
      { title },
    );
  if (status === 408 || status === 504)
    return _('Homebase took too long. Check the connection and try again: {{title}}', { title });
  return _('Homebase could not serve this book. Try again: {{title}}', { title });
};
