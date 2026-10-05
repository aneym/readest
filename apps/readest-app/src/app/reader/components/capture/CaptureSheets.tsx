import { useEffect, useRef, useState } from 'react';
import * as CFI from 'foliate-js/epubcfi.js';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { getBookProgress } from '@/store/readerProgressStore';
import { isHouseholdBuild } from '@/services/household';
import { captureThought, watchThoughtsQueue } from '@/services/thoughts/client';
import { eventDispatcher } from '@/utils/event';
import type { BookNote } from '@/types/book';

interface CaptureSession {
  bookKey: string;
  kind: 'page-note' | 'note' | 'voice';
  id: string;
  cfi: string;
  page?: number;
  title: string;
  author: string;
  calibreId?: number;
}

/** One reader-wide host; snapshot the page when opening, not when saving. */
export function CaptureSheets() {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!isHouseholdBuild()) return;
    const stopQueue = watchThoughtsQueue();
    const open = (event: CustomEvent) => {
      if (savingRef.current) return;
      const detail = event.detail;
      if (
        !detail ||
        typeof detail.bookKey !== 'string' ||
        !['page-note', 'note', 'voice'].includes(detail.kind)
      )
        return;
      const data = useBookDataStore.getState().getBookData(detail.bookKey);
      const progress = getBookProgress(detail.bookKey);
      const note = data?.config?.booknotes?.find(
        (item) => item.id === detail.id && !item.deletedAt,
      );
      let cfi = note?.cfi ?? progress?.location ?? '';
      try {
        cfi = CFI.collapse(cfi);
      } catch {
        /* Fixed-layout locators already name the page. */
      }
      setSession({
        bookKey: detail.bookKey,
        kind: detail.kind,
        id: note?.id ?? crypto.randomUUID(),
        cfi,
        page: note?.page ?? progress?.page,
        title: data?.book?.title ?? '',
        author: data?.book?.author ?? '',
        calibreId: data?.book?.calibreId,
      });
      setText(note?.note ?? '');
      setMessage('');
    };
    eventDispatcher.on('reader-capture-open', open);
    return () => {
      eventDispatcher.off('reader-capture-open', open);
      stopQueue();
    };
  }, []);

  const save = async () => {
    if (!session || !text.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage('');
    try {
      let body = text;
      if (session.kind === 'page-note') {
        const store = useBookDataStore.getState();
        const config = store.getConfig(session.bookKey);
        if (!config || !session.cfi) throw new Error('Missing page');
        const previous = config.booknotes?.find((note) => note.id === session.id);
        const note: BookNote = {
          ...previous,
          id: session.id,
          type: 'bookmark',
          cfi: session.cfi,
          page: session.page,
          note: text,
          createdAt: previous?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          deletedAt: null,
        };
        const updated = store.updateBooknotes(session.bookKey, [
          ...(config.booknotes ?? []).filter((item) => item.id !== session.id),
          note,
        ]);
        if (!updated) throw new Error('Missing book');
        await store.saveConfig(envConfig, session.bookKey, updated, settings);
        // The server ignores unknown JSON fields; put the attachment in its supported body.
        body += `\n\n${session.title} — ${session.author}\np. ${session.page ?? '?'}\n${session.cfi}`;
        if (session.calibreId != null) body += `\ncalibreId: ${session.calibreId}`;
      }
      const result = await captureThought({ body });
      if (result.ok || result.reason === 'offline') {
        setSession(null);
        if (!result.ok) setMessage(_("Saved offline. It sends when you're back."));
      } else {
        setMessage(
          result.reason === 'unpaired'
            ? _('Pair this reader with Homebase to save to Thoughts.')
            : _('Could not save to Thoughts. Try again.'),
        );
      }
    } catch {
      setMessage(_('Could not save. Try again.'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!isHouseholdBuild()) return null;
  const voiceUnavailable = _('Voice is unavailable in this build. Type your note instead.');
  return (
    <>
      {session && (
        <section
          role='dialog'
          aria-modal='true'
          aria-label={_(
            session.kind === 'page-note' ? 'Page note' : session.kind === 'note' ? 'Note' : 'Voice',
          )}
          className='bg-base-100 text-base-content fixed bottom-0 left-0 right-0 z-[100] border-t-2 border-current px-4 pb-4 pt-3'
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
        >
          <div className='mb-2 flex items-center justify-between text-sm font-medium'>
            <span>
              {session.kind === 'page-note'
                ? _('Page note · p. {{page}}', { page: session.page ?? '?' })
                : session.kind === 'note'
                  ? _('Note · saves to Thoughts')
                  : _('Voice · saves to Thoughts')}
            </span>
            <button
              type='button'
              disabled={saving}
              className='min-h-11 px-2'
              onClick={() => setSession(null)}
            >
              {_('Cancel')}
            </button>
          </div>
          {session.kind !== 'voice' && (
            <>
              <textarea
                aria-label={_('Note text')}
                value={text}
                maxLength={18_000}
                disabled={saving}
                onChange={(event) => setText(event.target.value)}
                className='min-h-24 w-full resize-none border-2 border-current bg-transparent p-2 text-base select-text'
              />
              <p className='mb-2 mt-2 text-sm leading-snug'>
                {session.kind === 'page-note'
                  ? _(
                      'Pinned to this page. It shows when you come back here, and in Thoughts with the page attached.',
                    )
                  : _(
                      'Not tied to {{title}}. Goes to Thoughts like one from the home screen or your phone.',
                      { title: session.title },
                    )}
              </p>
            </>
          )}
          <p id='capture-voice-reason' className='my-2 text-sm'>
            {voiceUnavailable}
          </p>
          <div className='flex gap-2'>
            <button
              type='button'
              disabled
              aria-describedby='capture-voice-reason'
              className='min-h-11 border-2 border-current px-3'
            >
              {_('Hold to talk')}
            </button>
            {session.kind !== 'voice' && (
              <button
                type='button'
                disabled={saving || !text.trim()}
                className='min-h-11 flex-1 border-2 border-current px-3 font-semibold'
                onClick={() => void save()}
              >
                {_('Save')}
              </button>
            )}
          </div>
          {message && (
            <p role='status' className='mt-2 text-sm'>
              {message}
            </p>
          )}
        </section>
      )}
      {!session && message && (
        <div
          role='status'
          className='bg-base-100 fixed bottom-4 left-4 right-4 z-[101] border border-current p-3'
          onClick={() => setMessage('')}
        >
          {message}
        </div>
      )}
    </>
  );
}
