import { useCallback } from 'react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderProgressStore } from '@/store/readerProgressStore';
import { isHouseholdBuild } from '@/services/household';
import { isCfiInLocation } from '@/utils/cfi';
import { eventDispatcher } from '@/utils/event';

export interface PageNote {
  id: string;
  text: string;
  cfi: string;
  page?: number;
  createdAt: number;
}
export function usePageNotes(bookKey: string): {
  notesOnCurrentPage: PageNote[];
  openPageNote: (id?: string) => void;
} {
  const config = useBookDataStore((state) => state.booksData[bookKey.split('-')[0]!]?.config);
  const progress = useReaderProgressStore((state) => state.progresses[bookKey]);
  const notesOnCurrentPage = isHouseholdBuild()
    ? (config?.booknotes ?? [])
        .filter(
          (note) =>
            note.type === 'bookmark' &&
            !note.deletedAt &&
            !!note.note &&
            isCfiInLocation(note.cfi, progress?.location),
        )
        .map((note) => ({
          id: note.id,
          text: note.note,
          cfi: note.cfi,
          page: note.page,
          createdAt: note.createdAt,
        }))
    : [];
  const openPageNote = useCallback(
    (id?: string) => {
      if (isHouseholdBuild())
        void eventDispatcher.dispatch('reader-capture-open', { bookKey, kind: 'page-note', id });
    },
    [bookKey],
  );
  return { notesOnCurrentPage, openPageNote };
}
