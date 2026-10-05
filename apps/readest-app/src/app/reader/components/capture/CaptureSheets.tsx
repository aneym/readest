import { useEffect, useRef, useState } from 'react';
import * as CFI from 'foliate-js/epubcfi.js';
import { useEnv } from '@/context/EnvContext';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';
import { isForcedMobileLayout } from '../../utils/mobileLayout';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { getBookProgress } from '@/store/readerProgressStore';
import { isHouseholdBuild } from '@/services/household';
import {
  captureThought,
  postVoiceThought,
  watchThoughtsQueue,
  type ThoughtAttachment,
} from '@/services/thoughts/client';
import { startWavRecording, type WavRecording } from '@/services/thoughts/wavRecorder';
import { eventDispatcher } from '@/utils/event';
import { isCfiInLocation } from '@/utils/cfi';
import { discoverClient } from '@/services/discover/client';
import type { PendingVoice } from '@/services/thoughts/voiceQueue';
import type { BookNote } from '@/types/book';

interface CaptureSession {
  bookKey: string;
  kind: 'page-note' | 'note' | 'voice';
  id: string;
  cfi: string;
  page?: number;
  title: string;
  author: string;
  attachment?: ThoughtAttachment;
  existing: boolean;
  pageNotes: BookNote[];
}

/** One reader-wide host; snapshot the page when opening, not when saving. */
export function CaptureSheets() {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const householdMobile =
    isHouseholdBuild() && (window.innerWidth < 640 || isForcedMobileLayout(appService?.isMobile));
  const keyboardInset = useKeyboardInset(householdMobile && !!session);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const held = useRef(false);
  const recorder = useRef<Promise<WavRecording> | null>(null);
  const pendingVoice = useRef<PendingVoice | null>(null);

  useEffect(
    () => () => {
      held.current = false;
      void recorder.current?.then((take) => take.cancel()).catch(() => {});
    },
    [],
  );

  const beginVoice = () => {
    if (savingRef.current || recorder.current || !session) return;
    held.current = true;
    setMessage('');
    setRecording(true);
    const take = startWavRecording();
    recorder.current = take;
    void take
      .then(() => {
        if (held.current) setRecording(true);
      })
      .catch((error: unknown) => {
        held.current = false;
        recorder.current = null;
        setRecording(false);
        setMessage(
          error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
            ? _('Microphone access is off. Allow it in Settings to record.')
            : _('Could not start recording. Try again.'),
        );
      });
  };

  const sendVoice = async () => {
    if (!session || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const pending = pendingVoice.current;
      if (!pending) return;
      const result = await postVoiceThought(
        pending.audio,
        pending.id,
        pending.recordedAt,
        pending.attachment,
      );
      if (result.ok) {
        pendingVoice.current = null;
        if (session.kind === 'page-note' && result.transcript) {
          await savePageNote(result.transcript);
        }
        setSession(null);
      } else if (result.reason === 'offline' && result.queued) {
        pendingVoice.current = null;
        setSession(null);
        setMessage(_("Saved offline. It sends when you're back."));
      } else {
        setMessage(
          result.reason === 'unpaired'
            ? _('Pair this reader with Homebase to save to Thoughts.')
            : _("Couldn't send. Try again when you're back online."),
        );
      }
    } catch {
      setMessage(_("Couldn't send. Try again when you're back online."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const finishVoice = async (cancel = false) => {
    if (!held.current) return;
    held.current = false;
    const take = recorder.current;
    // Block a second press while permission/AudioContext startup is pending.
    savingRef.current = true;
    setSaving(true);
    setRecording(false);
    try {
      const active = await take;
      if (!active) return;
      if (cancel) {
        active.cancel();
        return;
      }
      const audio = await active.stop();
      if (audio.size < 256) {
        setMessage(_('No audio recorded. Hold to talk again.'));
        return;
      }
      pendingVoice.current = {
        audio,
        id: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        attachment: session?.attachment,
      };
    } catch {
      // Startup displays the specific permission error above.
      return;
    } finally {
      recorder.current = null;
      savingRef.current = false;
      setSaving(false);
    }
    if (!cancel) await sendVoice();
  };

  useEffect(() => {
    if (!isHouseholdBuild()) return;
    const stopQueue = watchThoughtsQueue();
    const open = (event: CustomEvent) => {
      if (savingRef.current || recorder.current) return;
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
      const location = note?.cfi ?? progress?.location ?? '';
      let cfi = location;
      try {
        cfi = CFI.collapse(cfi);
      } catch {
        /* Fixed-layout locators already name the page. */
      }
      const page = note?.page ?? progress?.page;
      const title = data?.book?.title ?? '';
      const calibreId = data?.book?.calibreId;
      const attachment: ThoughtAttachment | undefined =
        detail.kind === 'page-note' && calibreId != null && title
          ? {
              kind: 'book',
              key: `calibre:${calibreId}`,
              title: title.slice(0, 300),
              ...(location && location.length <= 500 ? { location } : {}),
              ...(page != null && Number.isInteger(page) && page > 0 ? { page } : {}),
            }
          : undefined;
      const nextSession: CaptureSession = {
        bookKey: detail.bookKey,
        kind: detail.kind,
        id: note?.id ?? crypto.randomUUID(),
        cfi,
        page: note?.page ?? progress?.page,
        title: data?.book?.title ?? '',
        author: data?.book?.author ?? '',
        attachment,
        existing: !!note,
        pageNotes:
          detail.kind === 'page-note'
            ? (data?.config?.booknotes ?? [])
                .filter(
                  (item) =>
                    item.type === 'bookmark' &&
                    !item.deletedAt &&
                    !!item.note &&
                    isCfiInLocation(item.cfi, progress?.location),
                )
                .sort((a, b) => b.createdAt - a.createdAt)
            : [],
      };
      setSession(nextSession);
      // Book metadata only stores calibreId. Discover owns the shelf work-key mapping.
      if (detail.kind === 'page-note' && title) {
        void discoverClient
          .work({ title, author: data?.book?.author })
          .then((result) => {
            if (!result.ok) return;
            const ebook = result.data.work.owned.ebook;
            if (!ebook?.shelfKey || (calibreId != null && ebook.calibreId !== calibreId)) return;
            const resolved: ThoughtAttachment = {
              kind: 'book',
              key: ebook.shelfKey,
              title: title.slice(0, 300),
              ...(location && location.length <= 500 ? { location } : {}),
              ...(page != null && Number.isInteger(page) && page > 0 ? { page } : {}),
            };
            setSession((current) =>
              current === nextSession ? { ...current, attachment: resolved } : current,
            );
          })
          .catch(() => {});
      }
      pendingVoice.current = null;
      setText(note?.note ?? '');
      setMessage('');
    };
    eventDispatcher.on('reader-capture-open', open);
    return () => {
      eventDispatcher.off('reader-capture-open', open);
      stopQueue();
    };
  }, []);

  const savePageNote = async (content: string) => {
    if (!session) return;
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
      note: content,
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
  };

  const save = async () => {
    if (!session || !text.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage('');
    try {
      if (session.kind === 'page-note') {
        await savePageNote(text);
        if (session.existing) {
          setSession(null);
          return;
        }
      }
      const result = await captureThought({
        body: text,
        ...(session.attachment ? { attachment: session.attachment } : {}),
      });
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
  return (
    <>
      {session && (
        <section
          role='dialog'
          aria-modal='true'
          aria-label={_(
            session.kind === 'page-note' ? 'Page note' : session.kind === 'note' ? 'Note' : 'Voice',
          )}
          className='bg-base-100 text-base-content fixed bottom-0 left-0 right-0 z-[100] border-t border-base-content/20 px-4 pb-4 pt-3'
          style={{
            paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
            ...(householdMobile ? { bottom: `${keyboardInset}px` } : {}),
          }}
        >
          <div className='mb-2 flex items-center justify-between text-sm font-medium'>
            <span>
              {session.kind === 'page-note'
                ? _('Page note · p. {{page}}', { page: session.page ?? '?' })
                : session.kind === 'note'
                  ? _('Note · saves to Thoughts')
                  : _('Voice · saves to Thoughts')}
            </span>
            {session.kind === 'page-note' && session.pageNotes.length > 1 && session.existing && (
              <div className='ml-2 flex items-center gap-2'>
                <span>
                  {_('{{n}} of {{count}}', {
                    n: session.pageNotes.findIndex((note) => note.id === session.id) + 1,
                    count: session.pageNotes.length,
                  })}
                </span>
                <button
                  type='button'
                  disabled={saving || recording || !!pendingVoice.current}
                  className='min-h-11 px-2'
                  onClick={() => {
                    const index = session.pageNotes.findIndex((note) => note.id === session.id);
                    const note = session.pageNotes[(index + 1) % session.pageNotes.length]!;
                    setSession({ ...session, id: note.id, cfi: note.cfi, page: note.page });
                    setText(note.note);
                    setMessage('');
                  }}
                >
                  {_('Next')}
                </button>
              </div>
            )}
            <button
              type='button'
              disabled={saving || recording}
              className='min-h-11 px-2'
              onClick={() => {
                pendingVoice.current = null;
                setSession(null);
              }}
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
                disabled={saving || recording}
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
          {recording && (
            <p role='status' className='my-2 text-sm'>
              {_('Recording…')}
            </p>
          )}
          <div className='flex gap-2'>
            {!session.existing && (
              <button
                type='button'
                disabled={saving || !!pendingVoice.current}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  beginVoice();
                }}
                onPointerUp={() => void finishVoice()}
                onPointerCancel={() => void finishVoice(true)}
                onLostPointerCapture={() => void finishVoice(true)}
                onKeyDown={(event) => {
                  if ([' ', 'Enter'].includes(event.key)) {
                    event.preventDefault();
                    if (!event.repeat) beginVoice();
                  }
                }}
                onKeyUp={(event) => {
                  if ([' ', 'Enter'].includes(event.key)) {
                    event.preventDefault();
                    void finishVoice();
                  }
                }}
                onBlur={() => void finishVoice(true)}
                className='min-h-11 touch-none select-none border-2 border-current px-3'
              >
                {_('Hold to talk')}
              </button>
            )}
            {pendingVoice.current && !recording && (
              <button
                type='button'
                disabled={saving}
                className='min-h-11 border-2 border-current px-3'
                onClick={() => void sendVoice()}
              >
                {_('Retry')}
              </button>
            )}
            {session.kind !== 'voice' && (
              <button
                type='button'
                disabled={saving || recording || !text.trim()}
                className='min-h-11 flex-1 border-2 border-current px-3 font-semibold'
                onClick={() => void save()}
              >
                {_('Save')}
              </button>
            )}
          </div>
          {!session.existing && <p className='mt-2 text-sm'>{_('Sends when you let go.')}</p>}
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
