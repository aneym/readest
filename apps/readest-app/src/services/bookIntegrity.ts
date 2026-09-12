/**
 * Error prefix for a book file that exists but is not a usable book. A
 * transfer that fails this way must not be retried automatically: the bytes
 * the server holds are the problem, and re-fetching them cannot help. The
 * transfer manager keys off this prefix to keep the failure visible without
 * letting it starve other downloads. Kept dependency-free so the manager can
 * import it without pulling in the cloud/storage stack.
 */
export const BOOK_INTEGRITY_ERROR_PREFIX = 'Book file failed integrity check';

export class BookIntegrityError extends Error {
  constructor(book: { title: string }, reason: string) {
    super(`${BOOK_INTEGRITY_ERROR_PREFIX}: ${reason} (${book.title})`);
    this.name = 'BookIntegrityError';
  }
}

export const isBookIntegrityError = (message: string | undefined): boolean =>
  !!message && message.startsWith(BOOK_INTEGRITY_ERROR_PREFIX);
