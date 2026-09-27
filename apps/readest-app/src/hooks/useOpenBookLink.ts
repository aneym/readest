import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrent } from '@tauri-apps/plugin-deep-link';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { isTauriAppPlatform } from '@/services/environment';
import { isAudiobook } from '@/utils/audiobook';
import { navigateToReader } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import {
  parseBookDeepLink,
  parseHouseholdOpenLink,
  resolveHouseholdBook,
  type HouseholdOpenLink,
} from '@/utils/deeplink';
import { setPendingTTSAutoplay } from '@/utils/ttsAutoplay';
import { useTranslation } from './useTranslation';

// Module-scoped: survives hook remounts (library <-> reader). getCurrent()
// keeps returning the launch URL for the session, so without this guard every
// remount would re-read the cold-start URL.
let coldStartConsumed = false;

/**
 * Receive `readest://book/{hash}` deep links (home-screen widget taps) and open
 * the book in the reader. Subscribes to the shared 'app-incoming-url' event for
 * live taps and reads getCurrent() once for cold start, deferring until the
 * library has hydrated.
 */
export function useOpenBookLink() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const getBookByHash = useLibraryStore((s) => s.getBookByHash);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const pending = useRef<{ bookHash: string; autoplay?: boolean } | HouseholdOpenLink | null>(null);

  const resolveAndNavigate = useCallback(
    (link: { bookHash: string; autoplay?: boolean } | HouseholdOpenLink) => {
      const household = 'calibreId' in link;
      const book = household
        ? resolveHouseholdBook(useLibraryStore.getState().library, link)
        : getBookByHash(link.bookHash);
      if (!book || (household && book.deletedAt)) {
        if (household) router.push('/library');
        eventDispatcher.dispatch('toast', {
          type: 'warning',
          message: _(
            household ? 'This book is not on this device yet' : 'Book not in your library',
          ),
          timeout: 2500,
        });
        return;
      }
      const bookHash = book.hash;
      if (household) {
        // Only displayed keys count: viewStates retains detached views after a switch.
        const { bookKeys } = useReaderStore.getState();
        const alreadyOpen =
          window.location.pathname.startsWith('/reader') &&
          bookKeys.some((key) => key.startsWith(`${bookHash}-`));
        if (alreadyOpen) {
          eventDispatcher.dispatch('open-book-in-reader', { bookHash });
          if (link.mode === 'listen') {
            eventDispatcher.dispatch('household:deeplink-listen', { bookHash });
          }
          return;
        }
        if (link.mode === 'listen') setPendingTTSAutoplay(bookHash);
      } else if (link.autoplay) {
        setPendingTTSAutoplay(bookHash);
      }
      // A streaming audiobook has no document to load - it always opens in
      // the player, the same as a library tap on it (useOpenBook.ts). This
      // must come before the reader-mounted check below: switching it into
      // an already-mounted reader in place would drive initViewState down
      // the document-loader path a streaming ABS book has no file for, and
      // the reader hangs on the spinner.
      if (isAudiobook(book)) {
        router.push(`/player?id=${bookHash}`);
        return;
      }
      // If a reader is already mounted, switch in place via useBooksManager: it
      // focuses the book if it is already open (checked against the live
      // bookKeys) or replaces the open book(s) with it otherwise. A plain
      // navigateToReader does not re-init an already-mounted reader.
      if (window.location.pathname.startsWith('/reader')) {
        eventDispatcher.dispatch('open-book-in-reader', { bookHash });
        return;
      }

      // No reader mounted (library / cold start) - navigate fresh.
      navigateToReader(router, [bookHash]);
    },
    [_, getBookByHash, router],
  );

  useEffect(() => {
    if (!isTauriAppPlatform() || !appService) return;

    const handle = (url: string, coldStart = false) => {
      const parsed = parseHouseholdOpenLink(url) ?? parseBookDeepLink(url);
      if (!parsed) return;
      // Dedupe ONLY the cold-start path. The OS persists the launch deep link
      // and re-delivers it via getCurrent() on every reader reload, which would
      // re-open the book in a loop. Live taps (app-incoming-url) are genuine
      // user actions and must always be processed. sessionStorage survives
      // reloads (module state does not).
      if (coldStart) {
        try {
          if (sessionStorage.getItem('consumedColdStartBookUrl') === url) return;
          sessionStorage.setItem('consumedColdStartBookUrl', url);
        } catch {
          // sessionStorage unavailable - proceed.
        }
      }
      if (!useLibraryStore.getState().libraryLoaded) {
        pending.current = parsed;
        return;
      }
      resolveAndNavigate(parsed);
    };

    if (!coldStartConsumed) {
      coldStartConsumed = true;
      getCurrent()
        .then((urls) => urls?.forEach((u) => handle(u, true)))
        .catch(() => {});
    }

    const onIncoming = (event: CustomEvent) => {
      const { urls } = event.detail as { urls: string[] };
      urls.forEach((u) => handle(u));
    };
    eventDispatcher.on('app-incoming-url', onIncoming);
    return () => {
      eventDispatcher.off('app-incoming-url', onIncoming);
    };
  }, [appService, resolveAndNavigate]);

  useEffect(() => {
    if (!libraryLoaded || !pending.current) return;
    const link = pending.current;
    pending.current = null;
    resolveAndNavigate(link);
  }, [libraryLoaded, resolveAndNavigate]);
}
