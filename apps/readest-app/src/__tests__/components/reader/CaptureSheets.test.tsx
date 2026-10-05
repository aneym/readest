import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { CaptureSheets } from '@/app/reader/components/capture/CaptureSheets';
import { usePageNotes } from '@/app/reader/hooks/usePageNotes';
import { useBookDataStore } from '@/store/bookDataStore';
import { setBookProgress } from '@/store/readerProgressStore';
import { eventDispatcher } from '@/utils/event';
import { captureThought } from '@/services/thoughts/client';
import type { Book, BookConfig, BookProgress } from '@/types/book';

vi.mock('@/services/household', () => ({ isHouseholdBuild: () => true }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (text: string, values: Record<string, string> = {}) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key])),
}));
vi.mock('@/services/thoughts/client', () => ({
  captureThought: vi.fn(),
  postVoiceThought: vi.fn(),
  watchThoughtsQueue: () => () => {},
}));
const capture = vi.mocked(captureThought);
const saveConfig = vi.fn();
const key = 'book-view';
const location = 'epubcfi(/6/2!/4/2/1:0)';
const book = { hash: 'book', title: 'Titan', author: 'Ron Chernow', calibreId: 42 } as Book;
const progress = { location, page: 112 } as BookProgress;
beforeEach(() => {
  capture.mockReset();
  capture.mockResolvedValue({ ok: true, id: 'thought' });
  saveConfig.mockReset();
  saveConfig.mockResolvedValue(undefined);
  useBookDataStore.setState({
    booksData: {
      book: {
        id: 'book',
        book,
        file: null,
        config: { booknotes: [] } as unknown as BookConfig,
        bookDoc: null,
        isFixedLayout: false,
      },
    },
    saveConfig,
  });
  setBookProgress(key, progress);
});
afterEach(cleanup);
async function open(kind: 'note' | 'page-note' | 'voice', id?: string) {
  await act(async () => {
    await eventDispatcher.dispatch('reader-capture-open', { bookKey: key, kind, id });
  });
}

test('loose Note has the exact copy and Save sends no book attachment', async () => {
  render(<CaptureSheets />);
  await open('note');
  expect(screen.getByText('Note · saves to Thoughts')).toBeTruthy();
  expect(
    screen.getByText(
      'Not tied to Titan. Goes to Thoughts like one from the home screen or your phone.',
    ),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Book the dentist' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(capture).toHaveBeenCalledWith({ body: 'Book the dentist' });
  expect(saveConfig).not.toHaveBeenCalled();
});

test('page note persists a bookmark, is page scoped, and reopens for editing', async () => {
  render(<CaptureSheets />);
  const hook = renderHook(() => usePageNotes(key));
  await open('page-note');
  expect(screen.getByText('Page note · p. 112')).toBeTruthy();
  expect(
    screen.getByText(
      'Pinned to this page. It shows when you come back here, and in Thoughts with the page attached.',
    ),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Consistency compounds' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const note = useBookDataStore.getState().getConfig(key)!.booknotes![0]!;
  expect(note).toMatchObject({
    type: 'bookmark',
    note: 'Consistency compounds',
    cfi: location,
    page: 112,
  });
  expect(saveConfig).toHaveBeenCalledOnce();
  expect(capture).toHaveBeenCalledWith({
    body: `Consistency compounds\n\nTitan — Ron Chernow\np. 112\n${location}\ncalibreId: 42`,
  });
  expect(hook.result.current.notesOnCurrentPage.map((item) => item.text)).toEqual([
    'Consistency compounds',
  ]);
  act(() => setBookProgress(key, { ...progress, location: 'epubcfi(/6/4!/4/2/1:0)', page: 113 }));
  expect(hook.result.current.notesOnCurrentPage).toEqual([]);
  act(() => setBookProgress(key, progress));
  await act(async () => {
    hook.result.current.openPageNote(note.id);
  });
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Consistency compounds');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited thought' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(useBookDataStore.getState().getConfig(key)!.booknotes).toHaveLength(1);
  expect(hook.result.current.notesOnCurrentPage[0]?.text).toBe('Edited thought');
  expect(useBookDataStore.getState().getConfig(key)!.booknotes![0]!.id).toBe(note.id);
  expect(capture).toHaveBeenCalledOnce();
  expect(useBookDataStore.getState().getConfig(key)!.booknotes![0]!.hbKind).toBe('page-note');
});

test('offline save closes with honest copy; an unpaired save keeps the draft', async () => {
  render(<CaptureSheets />);
  capture.mockResolvedValueOnce({ ok: false, reason: 'offline' });
  await open('note');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Later' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() =>
    expect(screen.getByText("Saved offline. It sends when you're back.")).toBeTruthy(),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  capture.mockResolvedValueOnce({ ok: false, reason: 'unpaired' });
  await open('note');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Still here' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() =>
    expect(screen.getByText('Pair this reader with Homebase to save to Thoughts.')).toBeTruthy(),
  );
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Still here');
});
