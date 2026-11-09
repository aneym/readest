import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { isHouseholdBuild } from '@/services/household';
import { eventDispatcher } from '@/utils/event';
import { uniqueId } from '@/utils/misc';
import { NOTE_PREFIX } from '@/types/view';
import type { BookNote } from '@/types/book';
import type { TextSelection } from '@/utils/sel';
import { findAnnotationAtCfi } from '../../utils/annotatorUtil';
import { MARGIN_MARKS, joinMarkedNote, splitMarkedNote, type MarginMark } from './marginMarks';

interface NoteSession {
  bookKey: string;
  cfi: string;
  text: string;
  page: number;
  mark: MarginMark | null;
}

export function SelectionNoteSheet() {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const [session, setSession] = useState<NoteSession | null>(null);
  const [text, setText] = useState('');
  const [mark, setMark] = useState<MarginMark | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const keyboardInset = useKeyboardInset(!!session);

  useEffect(() => {
    if (!isHouseholdBuild()) return;
    const open = (event: CustomEvent) => {
      const detail = event.detail as
        | { bookKey?: string; selection?: TextSelection; mark?: MarginMark }
        | undefined;
      const selection = detail?.selection;
      if (!detail?.bookKey || !selection?.text) return;
      const view = useReaderStore.getState().getView(detail.bookKey);
      const cfi = selection.popup ? selection.cfi : view?.getCFI(selection.index, selection.range);
      if (!cfi) return;
      const config = useBookDataStore.getState().getConfig(detail.bookKey);
      const notes = config?.booknotes ?? [];
      const index = findAnnotationAtCfi(notes, cfi);
      const existing = index === -1 ? undefined : notes[index];
      const parsed = splitMarkedNote(existing?.note ?? '');
      setSession({
        bookKey: detail.bookKey,
        cfi,
        text: selection.text,
        page: selection.page,
        mark: parsed.mark,
      });
      setText(parsed.body);
      setMark(detail.mark ?? parsed.mark);
      setError('');
    };
    eventDispatcher.on('reader-selection-note-open', open);
    return () => eventDispatcher.off('reader-selection-note-open', open);
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [session]);

  const close = () => {
    inputRef.current?.blur();
    setSession(null);
  };

  const save = async () => {
    if (!session) return;
    const note = joinMarkedNote(mark, text);
    if (!note) return;
    const store = useBookDataStore.getState();
    const config = store.getConfig(session.bookKey);
    const view = useReaderStore.getState().getView(session.bookKey);
    if (!config) {
      setError(_('Could not save. Try again.'));
      return;
    }
    const annotations = [...(config.booknotes ?? [])];
    const index = findAnnotationAtCfi(annotations, session.cfi);
    const now = Date.now();
    let saved: BookNote;
    if (index !== -1) {
      saved = { ...annotations[index]!, note, updatedAt: now, deletedAt: null };
      annotations[index] = saved;
    } else {
      const style = settings.globalReadSettings.highlightStyle;
      saved = {
        id: uniqueId(),
        type: 'annotation',
        cfi: session.cfi,
        style,
        color: settings.globalReadSettings.highlightStyles[style],
        note,
        page: session.page,
        text: session.text,
        createdAt: now,
        updatedAt: now,
      };
      annotations.push(saved);
      view?.addAnnotation(saved);
    }
    view?.addAnnotation({ ...saved, value: `${NOTE_PREFIX}${saved.cfi}` });
    const updated = store.updateBooknotes(session.bookKey, annotations);
    if (!updated) {
      setError(_('Could not save. Try again.'));
      return;
    }
    await store.saveConfig(envConfig, session.bookKey, updated, settings);
    close();
  };

  if (!isHouseholdBuild() || !session) return null;
  const canSave = !!joinMarkedNote(mark, text);
  return (
    <section
      role='dialog'
      aria-modal='true'
      aria-label={_('Note')}
      className='selection-note-sheet bg-base-100 text-base-content border-base-content fixed left-0 right-0 z-[100] flex flex-col border-t-2 px-4 pt-3'
      style={{
        bottom: `${keyboardInset}px`,
        maxHeight: `calc(100% - ${keyboardInset}px - 24px)`,
        paddingBottom: keyboardInset > 0 ? '12px' : 'max(16px, env(safe-area-inset-bottom))',
      }}
    >
      <div className='mb-2 flex min-h-11 items-center justify-between gap-2'>
        <button
          type='button'
          className='min-h-11 min-w-16 px-2 text-start text-base'
          onClick={close}
        >
          {_('Cancel')}
        </button>
        <span className='text-base font-semibold'>{_('Note')}</span>
        <button
          type='button'
          disabled={!canSave}
          className={clsx(
            'min-h-11 min-w-16 border-2 px-3 text-base font-semibold',
            canSave
              ? 'bg-base-content text-base-100 border-base-content eink-inverted'
              : 'border-base-content',
          )}
          onClick={() => void save()}
        >
          {_('Save')}
        </button>
      </div>
      <blockquote className='border-base-content mb-3 line-clamp-3 shrink-0 border-s-4 ps-3 text-base leading-snug'>
        {session.text}
      </blockquote>
      <div className='mb-3 flex shrink-0 gap-2' role='group' aria-label={_('Margin mark')}>
        {MARGIN_MARKS.map((item) => (
          <button
            key={item.mark}
            type='button'
            aria-pressed={mark === item.mark}
            className={clsx(
              'border-base-content flex min-h-11 flex-1 items-center justify-center gap-1 border-2 px-2 text-base',
              mark === item.mark && 'bg-base-content text-base-100 eink-inverted font-semibold',
            )}
            onClick={() => setMark(mark === item.mark ? null : item.mark)}
          >
            <span className='text-lg font-bold'>{item.mark}</span>
            <span>{_(item.label)}</span>
          </button>
        ))}
      </div>
      <textarea
        ref={inputRef}
        aria-label={_('Note text')}
        value={text}
        rows={3}
        maxLength={18_000}
        placeholder={_('Write a note')}
        onChange={(event) => setText(event.target.value)}
        className='border-base-content placeholder:text-base-content min-h-20 w-full flex-1 resize-none border-2 bg-transparent p-2 text-base select-text'
      />
      {error && (
        <p role='status' className='mt-2 text-sm font-semibold'>
          {error}
        </p>
      )}
    </section>
  );
}
