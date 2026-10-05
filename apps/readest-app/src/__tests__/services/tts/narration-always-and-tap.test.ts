import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TTSController } from '@/services/tts/TTSController';
import { MediaOverlayTTS } from '@/services/tts/mediaOverlay';
import type { FoliateView } from '@/types/view';

// Integration boundary: real controller, overlay parser, text iterator and
// narration client. Only browser layout/audio and the external WS are faked.
// Protects stale opt-outs, spine-gap skipping and silent paused seeks; existing
// controller coverage has no point-hit path and expects the retired opt-out.
vi.mock('isomorphic-ws', () => ({
  default: class {
    addEventListener(type: string, listener: () => void) {
      if (type === 'error') queueMicrotask(listener);
    }
    close() {}
  },
}));

class TestAudio extends EventTarget {
  static instances: TestAudio[] = [];
  currentTime = 0;
  paused = true;
  src = '';
  playbackRate = 1;
  preservesPitch = true;
  playCount = 0;
  constructor() {
    super();
    TestAudio.instances.push(this);
  }
  async play() {
    this.paused = false;
    this.playCount++;
  }
  pause() {
    this.paused = true;
  }
  load() {}
}

const makeBookView = (overlays: boolean[]) => {
  const docs = overlays.map(() =>
    new DOMParser().parseFromString(
      '<html lang="en"><body><p id="s1">First sentence.</p><p id="s2">Second sentence.</p></body></html>',
      'text/html',
    ),
  );
  const sections = overlays.map((overlay, index) => ({
    id: `s${index}.xhtml`,
    createDocument: async () => docs[index]!,
    mediaOverlay: overlay ? { href: 'ch.smil', id: `smil${index}` } : null,
  }));
  const smil =
    '<smil><body><par><text src="ch.xhtml#s1"/><audio src="ch.mp3" clipBegin="0s" clipEnd="3s"/></par><par><text src="ch.xhtml#s2"/><audio src="ch.mp3" clipBegin="3s" clipEnd="7s"/></par></body></smil>';
  let lastRange: Range | undefined;
  const view = {
    book: {
      sections,
      toc: sections.map((section, index) => ({
        id: index,
        label: `Chapter ${index}`,
        href: section.id,
        index,
      })),
      splitTOCHref: (href: string) => href.split('#'),
      loadText: async () => smil,
      loadBlob: async () => new Blob(['audio']),
    },
    renderer: { primaryIndex: 0, getContents: () => docs.map((doc, index) => ({ doc, index })) },
    language: { isCJK: false, canonical: 'en' },
    getCFI: (_index: number, range: Range) => {
      lastRange = range;
      return 'epubcfi(/6/2!/4/2)';
    },
    resolveCFI: () => ({ anchor: () => lastRange }),
    tts: null,
  } as unknown as FoliateView;
  return { view, docs };
};

const controllers: TTSController[] = [];
beforeEach(() => {
  TestAudio.instances = [];
  vi.stubGlobal('Audio', TestAudio);
  URL.createObjectURL = vi.fn(() => 'blob:narration');
  URL.revokeObjectURL = vi.fn();
  // jsdom has no layout/hit testing. Give each text line its actual test hit box.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function (this: Range) {
      const element =
        this.startContainer.nodeType === Node.ELEMENT_NODE
          ? (this.startContainer as Element)
          : this.startContainer.parentElement!;
      const top = element.id === 's2' ? 30 : 10;
      return [{ left: 10, right: 100, top, bottom: top + 10 }] as unknown as DOMRectList;
    },
  });
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const setup = async (overlays = [true]) => {
  const { view, docs } = makeBookView(overlays);
  const controller = new TTSController(null, view);
  controllers.push(controller);
  controller.useNarration = false; // legacy ttsUseNarration:false
  await controller.init();
  await controller.initViewTTS(0);
  return { controller, view, docs };
};

const installCaret = (doc: Document) => {
  doc.caretRangeFromPoint = (_x, y) => {
    const range = doc.createRange();
    range.setStart(doc.getElementById(y >= 30 ? 's2' : 's1')!.firstChild!, 1);
    range.collapse(true);
    return range;
  };
};

describe('always-recorded narration and sentence taps', () => {
  test('stored false cannot opt a narrated book into synthesis', async () => {
    const { controller, view } = await setup();
    expect(controller.narrationActive).toBe(true);
    expect(view.tts).toBeInstanceOf(MediaOverlayTTS);
    expect(view.tts?.start()).toContain('First sentence.');
  });

  test('unnarrated front matter and middle sections skip to recorded text', async () => {
    const { controller, view, docs } = await setup([false, true, false, true]);
    expect(view.tts?.doc).toBe(docs[1]);
    view.tts?.setMark('1');
    controller.state = 'paused';
    await controller.forward(true);
    expect(view.tts?.doc).toBe(docs[3]);
    expect(view.tts).toBeInstanceOf(MediaOverlayTTS);
    expect(controller.narrationActive).toBe(true);
  });

  test.each([
    'playing',
    'paused',
  ] as const)('chapter navigation preserves %s intent and starts at its first sentence', async (state) => {
    const { controller, view, docs } = await setup([true, true, true]);
    view.tts?.setMark('1');
    controller.state = state;
    await controller.nextChapter();
    expect(view.tts?.doc).toBe(docs[1]);
    await vi.waitFor(() => expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.'));
    if (state === 'playing') await vi.waitFor(() => expect(controller.state).toBe('playing'));
    else expect(controller.state).toBe('forward-paused');
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[0]);
    await vi.waitFor(() => expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.'));
    if (state === 'paused')
      expect(TestAudio.instances.reduce((n, audio) => n + audio.playCount, 0)).toBe(0);
  });

  test('chapter transport uses TOC boundaries and skips unnarrated chapter front matter', async () => {
    const { controller, view, docs } = await setup([true, true, false, true]);
    view.book.toc = [view.book.toc![0]!, view.book.toc![2]!];
    controller.state = 'paused';
    await controller.nextChapter();
    expect(view.tts?.doc).toBe(docs[3]);
    expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.');
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[0]);
    expect(controller.state).toBe('forward-paused');
  });

  test('Previous restarts after five seconds, but crosses chapters at five seconds', async () => {
    const { controller, view, docs } = await setup([true, true]);
    controller.state = 'playing';
    await controller.nextChapter();
    await vi.waitFor(() => expect(TestAudio.instances.some((a) => !a.paused)).toBe(true));
    view.tts?.setMark('1');
    await controller.ensureTimeline();
    const audio = TestAudio.instances.find((a) => !a.paused)!;
    audio.currentTime = 6;
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[1]);
    await vi.waitFor(() => expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.'));
    await vi.waitFor(() => expect(controller.state).toBe('playing'));
    audio.currentTime = 5;
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[0]);
  });

  test('Previous restarts a multi-file TOC chapter even at the start of its second file', async () => {
    const { controller, view, docs } = await setup([true, true, true]);
    view.book.toc = [view.book.toc![0]!, view.book.toc![1]!];
    controller.state = 'paused';
    await controller.nextChapter();
    view.tts?.setMark('1');
    await controller.forward(true);
    expect(view.tts?.doc).toBe(docs[2]);
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[1]);
    expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.');
  });

  test('Next skips a whole unnarrated TOC chapter', async () => {
    const { controller, view, docs } = await setup([true, false, true]);
    controller.state = 'paused';
    await controller.nextChapter();
    expect(view.tts?.doc).toBe(docs[2]);
  });

  test('Previous in front matter finds the first narrated sentence', async () => {
    const { controller, view, docs } = await setup([true, true]);
    view.book.toc = [view.book.toc![1]!];
    view.tts?.setMark('1');
    controller.state = 'paused';
    await controller.previousChapter();
    expect(view.tts?.doc).toBe(docs[0]);
    expect(view.tts?.getLastRange()?.toString()).toBe('First sentence.');
  });

  test.each([
    'playing',
    'paused',
  ] as const)('a tap seeks section B itself while %s', async (state) => {
    const { controller, view, docs } = await setup([true, true]);
    installCaret(docs[1]!);
    controller.state = state;
    expect(await controller.handleNarrationTap(docs[1]!, 20, 35)).toBe(true);
    expect(view.tts?.doc).toBe(docs[1]);
    expect(view.tts?.getLastRange()?.toString()).toBe('Second sentence.');
    if (state === 'playing') {
      await vi.waitFor(() =>
        expect(TestAudio.instances.some((audio) => !audio.paused && audio.currentTime === 3)).toBe(
          true,
        ),
      );
    } else {
      expect(controller.state).toBe('forward-paused');
      expect(TestAudio.instances.reduce((count, audio) => count + audio.playCount, 0)).toBe(0);
    }
  });

  test('non-narration sessions do not consume taps', async () => {
    const { view, docs } = makeBookView([false]);
    const controller = new TTSController(null, view);
    controllers.push(controller);
    controller.state = 'paused';
    expect(await controller.handleNarrationTap(docs[0]!, 20, 35)).toBe(false);
  });

  test.each([
    'playing',
    'paused',
  ] as const)('%s taps seek without changing play intent', async (state) => {
    const { controller, view, docs } = await setup();
    const doc = docs[0]!;
    installCaret(doc);
    view.tts?.setMark('0');
    controller.state = state;
    expect(await controller.handleNarrationTap(doc, 20, 15)).toBe(false);
    expect(await controller.handleNarrationTap(doc, 200, 35)).toBe(false); // snapped margin
    expect(await controller.handleNarrationTap(doc, 20, 35)).toBe(true);
    // The sentence mark changes synchronously, before audio can load.
    expect(view.tts?.getLastRange()?.toString()).toBe('Second sentence.');
    if (state === 'playing') {
      await vi.waitFor(() =>
        expect(TestAudio.instances.some((audio) => !audio.paused && audio.currentTime === 3)).toBe(
          true,
        ),
      );
      expect(controller.state).toBe('playing');
    } else {
      await vi.waitFor(() => expect(controller.state).toBe('forward-paused'));
      expect(TestAudio.instances.reduce((count, audio) => count + audio.playCount, 0)).toBe(0);
      expect(view.tts?.resume()).toContain('Second sentence.');
      expect(view.tts?.resume()).not.toContain('First sentence.');
    }
  });
});
