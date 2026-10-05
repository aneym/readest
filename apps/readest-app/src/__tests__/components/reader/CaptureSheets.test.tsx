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
import { useReaderStore } from '@/store/readerStore';
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
    body: 'Consistency compounds',
    attachment: { kind: 'book', key: 'calibre:42', title: 'Titan', location, page: 112 },
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
  expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited thought' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(useBookDataStore.getState().getConfig(key)!.booknotes).toHaveLength(1);
  expect(hook.result.current.notesOnCurrentPage[0]?.text).toBe('Edited thought');
  expect(useBookDataStore.getState().getConfig(key)!.booknotes![0]!.id).toBe(note.id);
  expect(capture).toHaveBeenCalledOnce();
  expect(useBookDataStore.getState().getConfig(key)!.booknotes![0]!.hbKind).toBeUndefined();
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

test.each([
  'note',
  'page-note',
  'voice',
] as const)('%s sheet follows the mobile keyboard viewport without hiding its actions', async (kind) => {
  const viewport = Object.assign(new EventTarget(), { height: 824, offsetTop: 0 });
  vi.stubGlobal('innerWidth', 412);
  vi.stubGlobal('innerHeight', 824);
  vi.stubGlobal('visualViewport', viewport);
  try {
    render(<CaptureSheets />);
    await open(kind);
    const sheet = screen.getByRole('dialog');
    if (kind !== 'voice') fireEvent.focus(screen.getByRole('textbox'));
    act(() => {
      viewport.height = 504;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(sheet.style.bottom).toBe('320px');
    if (kind !== 'voice') {
      expect(sheet.contains(screen.getByRole('textbox'))).toBe(true);
      expect(sheet.contains(screen.getByRole('button', { name: 'Save' }))).toBe(true);
    }
    if (kind !== 'page-note') {
      expect(sheet.contains(screen.getByRole('button', { name: 'Hold to talk' }))).toBe(true);
    }
    act(() => {
      viewport.offsetTop = 20;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(sheet.style.bottom).toBe('300px');
    act(() => {
      viewport.height = 824;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(sheet.style.bottom).toBe('0px');
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

test('Save is an outline until there is text, then filled ink', async () => {
  render(<CaptureSheets />);
  await open('note');
  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
  expect(save.disabled).toBe(true);
  expect(save.className).toContain('font-normal');
  expect(save.className).not.toContain('bg-base-content');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Book the dentist' } });
  expect(save.disabled).toBe(false);
  expect(save.className).toContain('bg-base-content');
  expect(save.className).toContain('text-base-100');
  expect(save.className).toContain('eink-inverted');
  expect(save.className).not.toContain('font-normal');
});

test('the loose Note names the book by its short title', async () => {
  book.title = 'Titan: The Life of John D. Rockefeller, Sr.';
  try {
    render(<CaptureSheets />);
    await open('note');
    expect(
      screen.getByText(
        'Not tied to Titan. Goes to Thoughts like one from the home screen or your phone.',
      ),
    ).toBeTruthy();
  } finally {
    book.title = 'Titan';
  }
});

test.each([
  ['note', 'Saved to Thoughts'],
  ['page-note', 'Page note saved'],
] as const)('a saved %s closes to a footer line that clears after 3s', async (kind, notice) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useReaderStore.setState({ hoveredBookKey: key });
  try {
    render(<CaptureSheets />);
    await open(kind);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const line = screen.getByRole('status');
    expect(line.textContent).toBe(notice);
    expect(line.className).toContain('bottom-0');
    expect(line.className).toContain('border-t');
    expect(useReaderStore.getState().hoveredBookKey).toBe('');
    // Flush the passive effect that arms the timer before moving the clock.
    await act(async () => {});
    act(() => vi.advanceTimersByTime(2900));
    expect(screen.getByRole('status').textContent).toBe(notice);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('status')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('the sheet opens with the 2px reader rule', async () => {
  render(<CaptureSheets />);
  await open('page-note');
  const sheet = screen.getByRole('dialog');
  expect(sheet.classList.contains('border-t-2')).toBe(true);
  expect(sheet.classList.contains('border-base-content')).toBe(true);
});
