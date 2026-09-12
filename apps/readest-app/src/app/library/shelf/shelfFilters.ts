import type { Book, ReadingStatus } from '@/types/book';

/**
 * Household shelf filters. Categories come from Calibre tags that Homebase
 * relays on every book row (`Fiction`, `Nonfiction`, `Volumes`, `Digests`,
 * `Hidden`); reading state comes from the book's own progress and status.
 *
 * The filter is a *view*, never a mutation: nothing here changes a book. What
 * a filter hides is decided by rules the reader can predict from the chip
 * label, and "All" still excludes what is finished, abandoned or hidden —
 * those live under their own chip so the everyday shelf stays short.
 */
export type ShelfFilterId = 'reading' | 'fiction' | 'nonfiction' | 'volumes' | 'all' | 'finished';

export const SHELF_FILTER_IDS: readonly ShelfFilterId[] = [
  'reading',
  'fiction',
  'nonfiction',
  'volumes',
  'all',
  'finished',
];

export const DEFAULT_SHELF_FILTER: ShelfFilterId = 'reading';

export const SHELF_TAGS = {
  fiction: 'Fiction',
  nonfiction: 'Nonfiction',
  volumes: 'Volumes',
  digests: 'Digests',
  hidden: 'Hidden',
} as const;

/** A book opened this recently and this far in counts as being read now. */
export const READING_MIN_FRACTION = 0.01;
export const READING_RECENCY_DAYS = 45;
/** A book that arrived this recently and was never opened is surfaced as new. */
export const NEW_ARRIVAL_DAYS = 14;

const DAY_MS = 86_400_000;

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/** Tags from the sync row plus any subjects Calibre/EPUB metadata carried. */
export const shelfTagsOf = (book: Book): string[] => {
  const out: string[] = [];
  for (const tag of book.tags ?? []) out.push(lower(tag));
  const subjects = (book.metadata as { subjects?: unknown } | undefined)?.subjects;
  if (Array.isArray(subjects)) for (const s of subjects) out.push(lower(s));
  return out;
};

export const hasShelfTag = (book: Book, tag: string): boolean =>
  shelfTagsOf(book).includes(tag.toLowerCase());

export const isHiddenBook = (book: Book): boolean =>
  !!book.deletedAt || hasShelfTag(book, SHELF_TAGS.hidden);

const DONE: ReadonlySet<ReadingStatus> = new Set<ReadingStatus>(['finished', 'abandoned']);

export const isDoneBook = (book: Book): boolean =>
  !!book.readingStatus && DONE.has(book.readingStatus);

export const readFraction = (book: Book): number => {
  const [current, total] = book.progress ?? [];
  if (!current || !total || total <= 0) return 0;
  return Math.min(1, current / total);
};

export const isNewArrival = (book: Book, now = Date.now()): boolean =>
  !isDoneBook(book) &&
  readFraction(book) === 0 &&
  !book.readingStatus &&
  now - (book.createdAt ?? 0) <= NEW_ARRIVAL_DAYS * DAY_MS;

/**
 * "Reading" is explicit (`readingStatus === 'reading'`) or inferred: past the
 * first percent and touched within the recency window. `unread` is an explicit
 * opt-out; finished/abandoned never qualify.
 */
export const isReadingBook = (book: Book, now = Date.now()): boolean => {
  if (isDoneBook(book) || book.readingStatus === 'unread') return false;
  if (book.readingStatus === 'reading') return true;
  if (readFraction(book) < READING_MIN_FRACTION) return false;
  return now - (book.updatedAt ?? 0) <= READING_RECENCY_DAYS * DAY_MS;
};

export const matchesShelfFilter = (
  book: Book,
  filter: ShelfFilterId,
  now = Date.now(),
): boolean => {
  if (isHiddenBook(book)) return false;
  switch (filter) {
    case 'finished':
      return isDoneBook(book);
    case 'all':
      return !isDoneBook(book);
    case 'reading':
      return isReadingBook(book, now) || isNewArrival(book, now);
    case 'fiction':
      return !isDoneBook(book) && hasShelfTag(book, SHELF_TAGS.fiction);
    case 'nonfiction':
      return !isDoneBook(book) && hasShelfTag(book, SHELF_TAGS.nonfiction);
    case 'volumes':
      return !isDoneBook(book) && hasShelfTag(book, SHELF_TAGS.volumes);
  }
};

export const applyShelfFilter = (books: Book[], filter: ShelfFilterId, now = Date.now()): Book[] =>
  books.filter((book) => matchesShelfFilter(book, filter, now));

export const shelfFilterCounts = (
  books: Book[],
  now = Date.now(),
): Record<ShelfFilterId, number> => {
  const counts = { reading: 0, fiction: 0, nonfiction: 0, volumes: 0, all: 0, finished: 0 };
  for (const book of books) {
    for (const id of SHELF_FILTER_IDS) if (matchesShelfFilter(book, id, now)) counts[id]++;
  }
  return counts;
};

/** True when the library carries any household category tag at all. */
export const hasShelfCategories = (books: Book[]): boolean =>
  books.some(
    (book) =>
      hasShelfTag(book, SHELF_TAGS.fiction) ||
      hasShelfTag(book, SHELF_TAGS.nonfiction) ||
      hasShelfTag(book, SHELF_TAGS.volumes),
  );

export const ensureShelfFilterId = (value: unknown): ShelfFilterId =>
  SHELF_FILTER_IDS.includes(value as ShelfFilterId)
    ? (value as ShelfFilterId)
    : DEFAULT_SHELF_FILTER;
