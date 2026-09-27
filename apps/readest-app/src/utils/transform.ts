import {
  Book,
  BookConfig,
  BookFormat,
  BookNote,
  BookNoteType,
  HighlightColor,
  HighlightStyle,
  ReadingStatus,
} from '@/types/book';
import { DBBookConfig, DBBook, DBBookNote } from '@/types/records';
import { sanitizeString } from './sanitize';
import { buildFeedBookUrl } from '@/services/rss/feedBookUrl';
import { restoreAbsBookFields } from './audiobook';

// Homebase sends decoded JSON; the native cloud sends JSON strings. Never
// coerce objects through JSON.parse, or let a malformed optional field erase
// the local copy during the caller's merge.
const decodeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const decodeObject = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = decodeJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
};
const decodeProgress = (value: unknown): [number, number] | undefined => {
  const parsed = decodeJson(value);
  return Array.isArray(parsed) &&
    parsed.length === 2 &&
    parsed.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
    parsed[0] >= 0 &&
    parsed[1] > 0 &&
    parsed[0] <= parsed[1]
    ? (parsed as [number, number])
    : undefined;
};

// Supabase dates are ISO strings; Homebase clocks may already be epoch ms.
const clockMs = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
};
const rowClock = (row: object, snake: string, camel: string): number | undefined => {
  const fields = row as Record<string, unknown>;
  return clockMs(fields[snake]) ?? clockMs(fields[camel]);
};

export const transformBookConfigToDB = (bookConfig: unknown, userId: string): DBBookConfig => {
  const {
    bookHash,
    metaHash,
    progress,
    location,
    xpointer,
    rsvpPosition,
    searchConfig,
    viewSettings,
    updatedAt,
  } = bookConfig as BookConfig;

  return {
    user_id: userId,
    book_hash: bookHash!,
    meta_hash: metaHash,
    location: location,
    xpointer: xpointer,
    progress: progress && JSON.stringify(progress),
    rsvp_position: rsvpPosition && JSON.stringify(rsvpPosition),
    search_config: searchConfig && JSON.stringify(searchConfig),
    view_settings: viewSettings && JSON.stringify(viewSettings),
    updated_at: new Date(updatedAt ?? Date.now()).toISOString(),
  };
};

export const transformBookConfigFromDB = (dbBookConfig: DBBookConfig): BookConfig => {
  const {
    book_hash,
    meta_hash,
    progress,
    location,
    xpointer,
    rsvp_position,
    search_config,
    view_settings,
  } = dbBookConfig;
  // A Homebase config carries `hbFraction` (the reading fraction) because this
  // deployment has no page count to build `progress` from. It is rebuilt field
  // by field here, so relay it explicitly or the reader loses its anchor.
  const hbFraction = (dbBookConfig as DBBookConfig & { hbFraction?: number }).hbFraction;
  const decodedProgress = decodeProgress(progress);
  const rsvpPosition = decodeObject(rsvp_position);
  const searchConfig = decodeObject(search_config);
  const viewSettings = decodeObject(view_settings);
  return {
    bookHash: book_hash,
    metaHash: meta_hash,
    location,
    xpointer,
    ...(typeof hbFraction === 'number' &&
    Number.isFinite(hbFraction) &&
    hbFraction >= 0 &&
    hbFraction <= 1
      ? { hbFraction }
      : {}),
    ...(decodedProgress ? { progress: decodedProgress } : {}),
    ...(rsvpPosition ? { rsvpPosition } : {}),
    ...(searchConfig ? { searchConfig } : {}),
    ...(viewSettings ? { viewSettings } : {}),
    updatedAt: rowClock(dbBookConfig, 'updated_at', 'updatedAt') ?? Date.now(),
  } as BookConfig;
};

export const transformBookToDB = (book: unknown, userId: string): DBBook => {
  const {
    hash,
    metaHash,
    format,
    title,
    sourceTitle,
    author,
    groupId,
    groupName,
    tags,
    progress,
    readingStatus,
    readingStatusUpdatedAt,
    coverHash,
    coverUpdatedAt,
    metadata,
    metadataUpdatedAt,
    createdAt,
    updatedAt,
    deletedAt,
    uploadedAt,
  } = book as Book;

  return {
    user_id: userId,
    book_hash: hash,
    meta_hash: metaHash,
    format,
    title: sanitizeString(title)!,
    author: sanitizeString(author)!,
    group_id: groupId,
    group_name: sanitizeString(groupName),
    tags: tags,
    progress: progress,
    reading_status: readingStatus,
    reading_status_updated_at: readingStatusUpdatedAt
      ? new Date(readingStatusUpdatedAt).toISOString()
      : null,
    cover_hash: coverHash ?? null,
    cover_updated_at: coverUpdatedAt ? new Date(coverUpdatedAt).toISOString() : null,
    source_title: sanitizeString(sourceTitle),
    metadata: metadata ? sanitizeString(JSON.stringify(metadata)) : null,
    metadata_updated_at: metadataUpdatedAt ? new Date(metadataUpdatedAt).toISOString() : null,
    created_at: new Date(createdAt ?? Date.now()).toISOString(),
    updated_at: new Date(updatedAt ?? Date.now()).toISOString(),
    deleted_at: deletedAt ? new Date(deletedAt).toISOString() : null,
    uploaded_at: uploadedAt ? new Date(uploadedAt).toISOString() : null,
  };
};

export const transformBookFromDB = (dbBook: DBBook): Book => {
  const calibreId = (dbBook as DBBook & { calibre_id?: number }).calibre_id;
  const {
    book_hash,
    meta_hash,
    format,
    title,
    author,
    group_id,
    group_name,
    tags,
    progress,
    reading_status,
    reading_status_updated_at,
    cover_hash,
    cover_updated_at,
    source_title,
    metadata,
    metadata_updated_at,
    uploaded_at,
  } = dbBook;

  const updatedAt = rowClock(dbBook, 'updated_at', 'updatedAt');
  const createdAt = rowClock(dbBook, 'created_at', 'createdAt');
  const deletedAt = rowClock(dbBook, 'deleted_at', 'deletedAt');
  const coverImageUrl = (dbBook as DBBook & { coverImageUrl?: string | null }).coverImageUrl;
  const decodedMetadata = decodeObject(metadata);
  const book: Book = {
    hash: book_hash,
    ...(Number.isSafeInteger(calibreId) && calibreId! > 0 ? { calibreId } : {}),
    metaHash: meta_hash,
    format: format as BookFormat,
    title,
    author,
    groupId: group_id,
    groupName: group_name,
    tags: tags,
    progress: progress,
    readingStatus: reading_status as ReadingStatus,
    readingStatusUpdatedAt: reading_status_updated_at
      ? new Date(reading_status_updated_at).getTime()
      : undefined,
    coverHash: cover_hash ?? null,
    ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
    coverUpdatedAt: cover_updated_at ? new Date(cover_updated_at).getTime() : null,
    sourceTitle: source_title,
    ...(decodedMetadata
      ? {
          metadata: decodedMetadata as Book['metadata'],
          metadataUpdatedAt: metadata_updated_at ? new Date(metadata_updated_at).getTime() : null,
        }
      : metadata == null
        ? {
            metadataUpdatedAt: metadata_updated_at ? new Date(metadata_updated_at).getTime() : null,
          }
        : {}),
    createdAt: createdAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? createdAt ?? Date.now(),
    deletedAt: deletedAt ?? null,
    uploadedAt: uploaded_at ? new Date(uploaded_at).getTime() : null,
  };
  // Native cloud DBBook has no `url` column; a feed book carries its feed URL in
  // metadata so the reader can rebuild the feed:// descriptor here.
  if (!book.url && book.metadata?.feedUrl) {
    book.url = buildFeedBookUrl(book.metadata.feedUrl);
  }
  // Same story for an ABS stub, whose identity is its `abs://` filePath: no
  // column carries it (and the push strips filePath as device-local), so it
  // rides in metadata and is rebuilt here along with the badge fields.
  if (book.format === 'ABS') {
    restoreAbsBookFields(book);
  }
  return book;
};

export const transformBookNoteToDB = (bookNote: unknown, userId: string): DBBookNote => {
  const {
    bookHash,
    metaHash,
    id,
    type,
    cfi,
    xpointer0,
    xpointer1,
    page,
    text,
    style,
    color,
    note,
    global,
    hbKind,
    hbAudioSha256,
    hbAudioDurationMs,
    hbTranscriptSource,
    createdAt,
    updatedAt,
    deletedAt,
  } = bookNote as BookNote;

  return {
    user_id: userId,
    book_hash: bookHash!,
    meta_hash: metaHash,
    id,
    type,
    cfi,
    xpointer0,
    xpointer1,
    page,
    text: sanitizeString(text),
    style,
    color,
    note,
    global,
    ...(hbKind !== undefined ? { hbKind } : {}),
    ...(hbAudioSha256 !== undefined ? { hbAudioSha256 } : {}),
    ...(hbAudioDurationMs !== undefined ? { hbAudioDurationMs } : {}),
    ...(hbTranscriptSource !== undefined ? { hbTranscriptSource } : {}),
    created_at: new Date(createdAt ?? Date.now()).toISOString(),
    updated_at: new Date(updatedAt ?? Date.now()).toISOString(),
    // note that only null deleted_at is updated to the database, undefined is not
    deleted_at: deletedAt ? new Date(deletedAt).toISOString() : null,
  };
};

export const transformBookNoteFromDB = (dbBookNote: DBBookNote): BookNote => {
  const {
    book_hash,
    meta_hash,
    id,
    type,
    cfi,
    xpointer0,
    xpointer1,
    page,
    text,
    style,
    color,
    note,
    global,
  } = dbBookNote;

  const updatedAt = rowClock(dbBookNote, 'updated_at', 'updatedAt');
  const createdAt = rowClock(dbBookNote, 'created_at', 'createdAt');
  const deletedAt = rowClock(dbBookNote, 'deleted_at', 'deletedAt');
  const { hbKind, hbAudioSha256, hbAudioDurationMs, hbTranscriptSource } =
    dbBookNote as DBBookNote &
      Pick<BookNote, 'hbKind' | 'hbAudioSha256' | 'hbAudioDurationMs' | 'hbTranscriptSource'>;
  return {
    bookHash: book_hash,
    metaHash: meta_hash,
    id,
    type: type as BookNoteType,
    cfi: cfi ?? '',
    xpointer0,
    xpointer1,
    page,
    text,
    style: style as HighlightStyle,
    color: color as HighlightColor,
    note,
    global,
    ...(hbKind !== undefined ? { hbKind } : {}),
    ...(hbAudioSha256 !== undefined ? { hbAudioSha256 } : {}),
    ...(hbAudioDurationMs !== undefined ? { hbAudioDurationMs } : {}),
    ...(hbTranscriptSource !== undefined ? { hbTranscriptSource } : {}),
    createdAt: createdAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? createdAt ?? Date.now(),
    deletedAt: deletedAt ?? null,
  };
};
