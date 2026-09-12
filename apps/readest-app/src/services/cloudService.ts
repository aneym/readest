import { AppService, FileSystem, BaseDir, DeleteAction } from '@/types/system';
import { Book } from '@/types/book';
import {
  getDir,
  getLocalBookFilename,
  getRemoteBookFilename,
  getCoverFilename,
} from '@/utils/book';
import {
  downloadFile,
  uploadFile,
  uploadReplicaFile,
  deleteFile as deleteCloudFile,
  createProgressHandler,
  batchGetDownloadUrls,
} from '@/libs/storage';
import { ClosableFile } from '@/utils/file';
import { ProgressHandler } from '@/utils/transfer';
import { CLOUD_BOOKS_SUBDIR, CLOUD_REPLICAS_SUBDIR } from './constants';
import { isHomebaseSyncEnabled, resolveHomebaseCoverUrl } from './sync/homebase/config';
import { isBookFileContentSource, resolveBookContentSource } from './bookContent';
import { BookIntegrityError } from './bookIntegrity';

export {
  BookIntegrityError,
  isBookIntegrityError,
  BOOK_INTEGRITY_ERROR_PREFIX,
} from './bookIntegrity';

export async function deleteBook(
  fs: FileSystem,
  book: Book,
  deleteAction: DeleteAction,
): Promise<void> {
  if (deleteAction === 'local' || deleteAction === 'both' || deleteAction === 'purge') {
    const source = await resolveBookContentSource(fs, book);
    // Only remove files Readest itself created. A 'managed' source lives under
    // our Books/<hash>/ dir (a copy we made on import), so it is ours to delete.
    // An 'external' source is the user's own file at a user-controlled location
    // (book.filePath, base 'None') — e.g. a "Read books in place" import or a
    // transiently-opened file. Deleting a book from Readest must NEVER remove
    // that source file; doing so silently destroyed users' originals.
    if (source.kind === 'managed' && deleteAction !== 'purge') {
      // Purge wipes the whole directory below, so skip the per-file removal.
      if (await fs.exists(source.path, source.base)) {
        await fs.removeFile(source.path, source.base);
      }
    }

    // Purge erases the entire app-generated Books/<hash>/ directory — the
    // managed book file, cover.png, and (the reason for issue #4615)
    // config.json (reading progress, notes, bookmarks) + nav.json that the
    // other delete actions leave behind. In-place books keep their external
    // source file untouched; this only clears Readest's own sidecar dir.
    if (deleteAction === 'purge') {
      const dir = getDir(book);
      if (await fs.exists(dir, 'Books')) {
        await fs.removeDir(dir, 'Books', true);
      }
      // The per-book TTS audio cache lives under Cache (kept out of Books/
      // so backups and sync never pick it up); purge erases every trace of
      // the book, so drop it too. Non-purge deletes leave it: like
      // config.json, a re-downloaded book resumes with a warm audio cache.
      const ttsCacheDir = `tts-cache/${book.hash}`;
      if (await fs.exists(ttsCacheDir, 'Cache')) {
        await fs.removeDir(ttsCacheDir, 'Cache', true);
      }
    }

    if (deleteAction === 'both' && (await fs.exists(getCoverFilename(book), 'Books'))) {
      await fs.removeFile(getCoverFilename(book), 'Books');
    }
    if (deleteAction === 'local' || deleteAction === 'purge') {
      // Mirror 'local': mark not-downloaded but leave the tombstone (deletedAt)
      // to the caller. The page's handleBookDelete sets deletedAt and queues the
      // cloud deletion for purge, exactly as it does for the 'both' action.
      book.downloadedAt = null;
    } else {
      book.deletedAt = Date.now();
      book.downloadedAt = null;
      book.coverDownloadedAt = null;
    }
  }
  if ((deleteAction === 'cloud' || deleteAction === 'both') && book.uploadedAt) {
    const fps = [getRemoteBookFilename(book), getCoverFilename(book)];
    for (const fp of fps) {
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${fp}`;
      try {
        deleteCloudFile(cfp);
      } catch (error) {
        console.log('Failed to delete uploaded file:', error);
      }
    }
    book.uploadedAt = null;
  }
}

export async function uploadFileToCloud(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  lfp: string,
  cfp: string,
  base: BaseDir,
  handleProgress: ProgressHandler,
  hash: string,
  temp: boolean = false,
  media?: string,
): Promise<string | undefined> {
  console.log('Uploading file:', lfp, 'to', cfp);
  const file = await fs.openFile(lfp, base, cfp);
  const localFullpath = await resolveFilePath(lfp, base);
  const downloadUrl = await uploadFile(file, localFullpath, handleProgress, hash, temp, media);
  const f = file as ClosableFile;
  if (f && f.close) {
    await f.close();
  }
  return downloadUrl;
}

// Upload a single replica binary to the cloud under
// CLOUD_REPLICAS_SUBDIR/<kind>/<replicaId>/<filename>. Filename is the
// caller-supplied logical name (server-validated; see replicaSchemas.ts).
export async function uploadReplicaFileToCloud(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  opts: {
    kind: string;
    replicaId: string;
    filename: string;
    lfp: string;
    base: BaseDir;
    onProgress: ProgressHandler;
  },
): Promise<void> {
  const cfp = `${CLOUD_REPLICAS_SUBDIR}/${opts.kind}/${opts.replicaId}/${opts.filename}`;
  console.log('Uploading replica file:', opts.lfp, 'to', cfp);
  const file = await fs.openFile(opts.lfp, opts.base, opts.filename);
  const localFullpath = await resolveFilePath(opts.lfp, opts.base);
  await uploadReplicaFile(file, localFullpath, cfp, opts.kind, opts.replicaId, opts.onProgress);
  const f = file as ClosableFile;
  if (f && f.close) {
    await f.close();
  }
}

// Cloud key for a replica binary. Centralized so adapters and the
// download path share the same path-construction rule.
export const replicaCloudKey = (kind: string, replicaId: string, filename: string): string =>
  `${CLOUD_REPLICAS_SUBDIR}/${kind}/${replicaId}/${filename}`;

export async function downloadReplicaFileFromCloud(
  appService: AppService,
  opts: {
    kind: string;
    replicaId: string;
    filename: string;
    dst: string;
    onProgress?: ProgressHandler;
  },
): Promise<void> {
  const cfp = replicaCloudKey(opts.kind, opts.replicaId, opts.filename);
  await downloadFile({
    appService,
    cfp,
    dst: opts.dst,
    onProgress: opts.onProgress,
  });
}

export async function deleteReplicaBundleFromCloud(
  kind: string,
  replicaId: string,
  filenames: string[],
): Promise<void> {
  for (const filename of filenames) {
    const cfp = replicaCloudKey(kind, replicaId, filename);
    try {
      await deleteCloudFile(cfp);
    } catch (error) {
      console.log(`Failed to delete replica file ${cfp}:`, error);
    }
  }
}

export async function uploadBook(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  const completedFiles = { count: 0 };
  const coverExist = await fs.exists(getCoverFilename(book), 'Books');

  let bookSource = await resolveBookContentSource(fs, book);
  if (bookSource.kind === 'url') {
    const fileobj = await fs.openFile(bookSource.path, bookSource.base);
    await fs.writeFile(getLocalBookFilename(book), 'Books', await fileobj.arrayBuffer());
    const f = fileobj as ClosableFile;
    if (f && f.close) {
      await f.close();
    }
    bookSource = { kind: 'managed', path: getLocalBookFilename(book), base: 'Books' };
  }

  if (!isBookFileContentSource(bookSource)) {
    throw new Error('Book file not uploaded');
  }

  const toUploadFpCount = coverExist ? 2 : 1;
  const handleProgress = createProgressHandler(toUploadFpCount, completedFiles, onProgress);

  if (coverExist) {
    const lfp = getCoverFilename(book);
    const cfp = `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`;
    await uploadFileToCloud(fs, resolveFilePath, lfp, cfp, 'Books', handleProgress, book.hash);
    completedFiles.count++;
  }

  const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
  await uploadFileToCloud(
    fs,
    resolveFilePath,
    bookSource.path,
    cfp,
    bookSource.base,
    handleProgress,
    book.hash,
  );
  completedFiles.count++;

  book.deletedAt = null;
  book.fileSyncDeletionRequestedAt = null;
  book.updatedAt = Date.now();
  book.uploadedAt = Date.now();
  book.downloadedAt = Date.now();
  book.coverDownloadedAt = Date.now();
}

// Re-upload only the cover (books/<hash>/cover.png), overwriting the cloud
// copy. Used after a cover edit (issue #4544) so peers can re-download it.
// Deliberately does NOT touch book.uploadedAt — that marker means "the book
// file is in cloud as of T"; a cover-only change must not trigger a file
// re-download on peers.
export async function uploadBookCover(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (!(await fs.exists(getCoverFilename(book), 'Books'))) return;
  const completedFiles = { count: 0 };
  const handleProgress = createProgressHandler(1, completedFiles, onProgress);
  const lfp = getCoverFilename(book);
  const cfp = `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`;
  await uploadFileToCloud(fs, resolveFilePath, lfp, cfp, 'Books', handleProgress, book.hash);
}

export async function downloadCloudFile(
  appService: AppService,
  localBooksDir: string,
  lfp: string,
  cfp: string,
  onProgress: ProgressHandler,
): Promise<void> {
  console.log('Downloading file:', cfp, 'to', lfp);
  const dstPath = `${localBooksDir}/${lfp}`;
  await downloadFile({ appService, cfp, dst: dstPath, onProgress });
}

export async function downloadBookCovers(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  books: Book[],
): Promise<void> {
  const booksLfps = new Map(
    books.map((book) => {
      const lfp = getCoverFilename(book);
      return [lfp, book];
    }),
  );
  // Covers come from the household server, freshly signed. A book row's own
  // `coverImageUrl` is only usable while it is still the remote URL: once a
  // cover lands on disk the app rewrites it to a local asset:// path, so a
  // later pass must re-resolve rather than "download" that local path.
  const isRemoteCover = (book: Book): boolean =>
    /^https?:\/\//.test(book.coverImageUrl ?? '') &&
    !/^https?:\/\/(asset|tauri)\.localhost/.test(book.coverImageUrl ?? '');
  const homebaseTargets = isHomebaseSyncEnabled()
    ? await Promise.all(
        books.map(async (book) => ({
          lfp: getCoverFilename(book),
          cfp: `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`,
          downloadUrl: isRemoteCover(book)
            ? (book.coverImageUrl ?? undefined)
            : ((await resolveHomebaseCoverUrl(book.hash)) ?? undefined),
        })),
      )
    : books.filter(isRemoteCover).map((book) => ({
        lfp: getCoverFilename(book),
        cfp: `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`,
        downloadUrl: book.coverImageUrl ?? undefined,
      }));
  const directUrls = homebaseTargets.filter((target) => Boolean(target.downloadUrl));
  const resolvedLfps = new Set(directUrls.map((target) => target.lfp));
  const stockBooks = books.filter((book) => !resolvedLfps.has(getCoverFilename(book)));
  const filePaths = stockBooks.map((book) => ({
    lfp: getCoverFilename(book),
    cfp: `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`,
  }));
  let downloadUrls: { lfp: string; cfp: string; downloadUrl?: string }[] = directUrls;
  if (filePaths.length > 0) {
    try {
      downloadUrls = [...directUrls, ...(await batchGetDownloadUrls(filePaths))];
    } catch (error) {
      // Covers are a nicety; never let their URL resolution abort adoption.
      console.log('Batch cover URL resolution failed; continuing without', error);
    }
  }
  await Promise.all(
    books.map(async (book) => {
      if (!(await fs.exists(getDir(book), 'Books'))) {
        await fs.createDir(getDir(book), 'Books');
      }
    }),
  );
  await Promise.all(
    downloadUrls.map(async (file) => {
      try {
        const dst = `${localBooksDir}/${file.lfp}`;
        if (!file.downloadUrl) return;
        await downloadFile({ appService, dst, cfp: file.cfp, url: file.downloadUrl });
        const book = booksLfps.get(file.lfp);
        if (book && !book.coverDownloadedAt) {
          book.coverDownloadedAt = Date.now();
        }
      } catch (error) {
        console.log(`Failed to download cover file for book: '${file.lfp}'`, error);
      }
    }),
  );
}

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06];
// EOCD record is 22 bytes plus an optional comment of at most 65535 bytes.
const ZIP_EOCD_SEARCH_WINDOW = 22 + 65535;
const ZIP_BASED_FORMATS = new Set<Book['format']>(['EPUB', 'CBZ', 'FBZ']);

const bytesAt = (view: Uint8Array, offset: number, expected: number[]): boolean =>
  expected.every((byte, i) => view[offset + i] === byte);

const findBackwards = (view: Uint8Array, expected: number[]): boolean => {
  for (let i = view.length - expected.length; i >= 0; i--) {
    if (bytesAt(view, i, expected)) return true;
  }
  return false;
};

/**
 * Prove that the managed book file on disk is a complete document, not a
 * truncated or foreign byte string. Only `null` means the file is trustworthy;
 * otherwise the string names what is wrong.
 *
 * A ZIP container (EPUB, CBZ, FBZ) must start with a local file header and end
 * with an end-of-central-directory record; a stream cut short keeps the header
 * but never receives the EOCD, so this catches every partial download the old
 * native writer left at the final path. Other formats are only checked for
 * being non-empty — there is no cheap structural proof for them.
 */
export async function verifyLocalBookFile(fs: FileSystem, book: Book): Promise<string | null> {
  const lfp = getLocalBookFilename(book);
  if (!(await fs.exists(lfp, 'Books'))) return 'file missing';
  const file = await fs.openFile(lfp, 'Books');
  try {
    const size = file.size;
    if (!size) return 'empty file';
    if (!ZIP_BASED_FORMATS.has(book.format)) return null;
    if (size < 22) return 'too small to be a zip container';
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!bytesAt(head, 0, ZIP_LOCAL_HEADER)) return 'missing zip local file header';
    const tailStart = Math.max(0, size - ZIP_EOCD_SEARCH_WINDOW);
    const tail = new Uint8Array(await file.slice(tailStart, size).arrayBuffer());
    if (!findBackwards(tail, ZIP_EOCD)) return 'missing zip end-of-central-directory (truncated)';
    return null;
  } finally {
    const closable = file as ClosableFile;
    if (closable.close) await closable.close();
  }
}

export async function downloadBook(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
  onlyCover: boolean = false,
  redownload: boolean = false,
  onProgress?: ProgressHandler,
): Promise<void> {
  let bookDownloaded = false;
  let bookCoverDownloaded = false;
  const completedFiles = { count: 0 };
  let toDownloadFpCount = 0;
  const needDownCover = !(await fs.exists(getCoverFilename(book), 'Books')) || redownload;
  // A file sitting at the final path is not proof of a complete download: the
  // pre-atomic native writer created the target before streaming, so an
  // interrupted transfer left partial bytes there and the next attempt would
  // skip the fetch and stamp `downloadedAt`. Verify before trusting it, and
  // re-fetch when it does not hold up.
  let localBookVerified = false;
  if (!onlyCover && !redownload && (await fs.exists(getLocalBookFilename(book), 'Books'))) {
    const problem = await verifyLocalBookFile(fs, book);
    if (problem) {
      console.warn(`Discarding unusable local book file for '${book.title}': ${problem}`);
      await fs.removeFile(getLocalBookFilename(book), 'Books');
    } else {
      localBookVerified = true;
    }
  }
  const needDownBook = (!onlyCover && !localBookVerified) || redownload;
  if (needDownCover) {
    toDownloadFpCount++;
  }
  if (needDownBook) {
    toDownloadFpCount++;
  }

  const handleProgress = createProgressHandler(toDownloadFpCount, completedFiles, onProgress);

  if (!(await fs.exists(getDir(book), 'Books'))) {
    await fs.createDir(getDir(book), 'Books');
  }

  try {
    if (needDownCover) {
      const lfp = getCoverFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${lfp}`;
      await downloadCloudFile(appService, localBooksDir, lfp, cfp, handleProgress);
      bookCoverDownloaded = true;
    }
  } catch (error) {
    // don't throw error here since some books may not have cover images at all
    console.log(`Failed to download cover file for book: '${book.title}'`, error);
  } finally {
    if (needDownCover) {
      completedFiles.count++;
    }
  }

  if (needDownBook) {
    const lfp = getLocalBookFilename(book);
    const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
    await downloadCloudFile(appService, localBooksDir, lfp, cfp, handleProgress);
    completedFiles.count++;
    // The native transfer resolves only after the full announced body landed
    // and was renamed into place; this proves the bytes are also a document.
    const problem = await verifyLocalBookFile(fs, book);
    if (problem) {
      if (await fs.exists(lfp, 'Books')) await fs.removeFile(lfp, 'Books');
      throw new BookIntegrityError(book, problem);
    }
    bookDownloaded = true;
  }
  // some books may not have cover image, so we need to check if the book is downloaded
  if (bookDownloaded || (!onlyCover && !needDownBook)) {
    book.downloadedAt = Date.now();
  }
  if ((bookCoverDownloaded || !needDownCover) && !book.coverDownloadedAt) {
    book.coverDownloadedAt = Date.now();
  }
}
