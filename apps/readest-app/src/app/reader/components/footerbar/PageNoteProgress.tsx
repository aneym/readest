import { usePageNotes } from '../../hooks/usePageNotes';
import { useTranslation } from '@/hooks/useTranslation';

export const PageNoteProgress = ({ bookKey }: { bookKey: string }) => {
  const _ = useTranslation();
  const { notesOnCurrentPage, openPageNote } = usePageNotes(bookKey);
  if (!notesOnCurrentPage.length) return null;
  return (
    <button
      type='button'
      className='pointer-events-auto shrink-0 text-xs font-semibold'
      onClick={(event) => {
        event.stopPropagation();
        openPageNote(notesOnCurrentPage[0]?.id);
      }}
    >
      {notesOnCurrentPage.length === 1
        ? _('1 page note')
        : _('{{count}} page notes', { count: notesOnCurrentPage.length })}
    </button>
  );
};
