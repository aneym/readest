import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Screen-off narration on Android (BOOX lock): with the page hidden, the WebView's
// timers are throttled and no frames are drawn. Narration has to keep playing
// across blocks, files and sections from native events alone, draw nothing, and
// land one navigation + highlight on the sentence now sounding when the page is
// visible again.

const { FakeNativePlayer } = vi.hoisted(() => {
  // Stand-in for the ExoPlayer-backed NativeNarrationPlayer. It only records
  // what the client asks of it; the test moves its clock and fires its events.
  class FakeNativePlayer {
    static last: FakeNativePlayer | null = null;
    href: string | null = null;
    playbackRate = 1;
    paused = true;
    time = 0;
    calls: string[] = [];
    #listeners = new Map<string, Set<() => void>>();
    #heldRefresh: { resolve: () => void } | null = null;
    #holdNextRefresh = false;

    constructor() {
      FakeNativePlayer.last = this;
    }
    get currentTime(): number {
      return this.time;
    }
    set currentTime(value: number) {
      this.time = value;
      this.calls.push(`seek:${value}`);
    }
    addEventListener(type: string, fn: () => void): void {
      if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
      this.#listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: () => void): void {
      this.#listeners.get(type)?.delete(fn);
    }
    async load(href: string, _blob: Blob, startSec = 0): Promise<void> {
      this.href = href;
      this.time = startSec;
      this.calls.push(`load:${href}`);
    }
    async loadPath(href: string, _path: string, startSec = 0): Promise<void> {
      await this.load(href, new Blob(), startSec);
    }
    async seek(seconds: number): Promise<void> {
      this.time = seconds;
      this.calls.push(`seek:${seconds}`);
    }
    async play(): Promise<void> {
      this.paused = false;
      this.calls.push('play');
    }
    pause(): void {
      this.paused = true;
      this.calls.push('pause');
    }
    async setRate(rate: number): Promise<void> {
      this.playbackRate = rate;
    }
    async refreshPosition(): Promise<number> {
      this.calls.push('refresh');
      if (this.#holdNextRefresh) {
        this.#holdNextRefresh = false;
        await new Promise<void>((resolve) => {
          this.#heldRefresh = { resolve };
        });
      }
      return this.time;
    }
    invalidateSession(): void {}
    async release(): Promise<void> {}
    async shutdown(): Promise<void> {}

    // Test drivers.
    holdNextRefresh(): void {
      this.#holdNextRefresh = true;
    }
    releaseRefresh(): void {
      this.#heldRefresh?.resolve();
      this.#heldRefresh = null;
    }
    fireEnded(): void {
      this.paused = true;
      for (const fn of [...(this.#listeners.get('ended') ?? [])]) fn();
    }
  }
  return { FakeNativePlayer };
});

vi.mock('@/services/tts/mediaOverlay/NativeNarrationPlayer', () => ({
  NativeNarrationPlayer: FakeNativePlayer,
}));

// The real TTSController is driven in one test below. Its synthesis clients
// are stubbed out; narration runs on the real MediaOverlayClient.
const { stubClient } = vi.hoisted(() => ({
  stubClient: (name: string) => ({
    name,
    initialized: false,
    init: async () => false,
    shutdown: async () => undefined,
    getAllVoices: async () => [],
    getVoices: async () => [],
    setPrimaryLang: () => undefined,
    getCapabilities: () => ({ wordBoundaries: false, mediaClock: true }),
  }),
}));
vi.mock('@/services/tts/WebSpeechClient', () => ({
  WebSpeechClient: function (this: object) {
    Object.assign(this, stubClient('web-speech'));
  },
}));
vi.mock('@/services/tts/EdgeTTSClient', () => ({
  DEFAULT_SENTENCE_GAP_SEC: 0.15,
  EdgeTTSClient: function (this: object) {
    Object.assign(this, stubClient('edge-tts'));
  },
}));
vi.mock('@/services/tts/NativeTTSClient', () => ({
  NativeTTSClient: function (this: object) {
    Object.assign(this, stubClient('native-tts'));
  },
}));
vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredClient: () => null,
    setPreferredClient: () => undefined,
    setPreferredVoice: () => undefined,
    getPreferredVoice: () => null,
  },
}));
vi.mock('foliate-js/overlayer.js', () => ({ Overlayer: { highlight: 'highlightFn' } }));

vi.mock('@/utils/misc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/misc')>()),
  getOSPlatform: () => 'android',
}));

import type { BookDoc } from '@/libs/document';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';
import { TTSController } from '@/services/tts/TTSController';
import type { FoliateView } from '@/types/view';
import { MediaOverlayClient } from '@/services/tts/mediaOverlay/MediaOverlayClient';
import {
  loadMediaOverlaySection,
  type MediaOverlaySection,
} from '@/services/tts/mediaOverlay/MediaOverlaySection';
import { MediaOverlayTTS } from '@/services/tts/mediaOverlay/MediaOverlayTTS';
import { parseSSMLMarks } from '@/utils/ssml';

const par = (id: string, audio: string, begin: number, end: number) =>
  `<par><text src="ch.xhtml#${id}"/><audio src="${audio}" clipBegin="${begin}s" clipEnd="${end}s"/></par>`;
const smil = (body: string) =>
  `<smil xmlns="http://www.w3.org/ns/SMIL"><body>${body}</body></smil>`;

// Section 0: four blocks in a.mp3 (a word-timed first paragraph, then three
// whole paragraphs), then two blocks in b.mp3. Section 1: two blocks in c.mp3.
// Mark names are section-global ordinals: w1..w3 = 0..2, p2..p6 = 3..7.
const SMIL_0 = smil(
  par('w1', 'a.mp3', 0, 1) +
    par('w2', 'a.mp3', 1, 2) +
    par('w3', 'a.mp3', 2, 3) +
    par('p2', 'a.mp3', 3, 5) +
    par('p3', 'a.mp3', 5, 7) +
    par('p4', 'a.mp3', 7, 9) +
    par('p5', 'b.mp3', 0, 2) +
    par('p6', 'b.mp3', 2, 4),
);
const HTML_0 =
  '<p id="p1"><span id="w1">Alpha</span> <span id="w2">beta</span> <span id="w3">gamma</span></p>' +
  '<p id="p2">Second paragraph.</p><p id="p3">Third paragraph.</p><p id="p4">Fourth paragraph.</p>' +
  '<p id="p5">Fifth paragraph.</p><p id="p6">Sixth paragraph.</p>';
const SMIL_1 = smil(par('p7', 'c.mp3', 0, 3) + par('p8', 'c.mp3', 3, 6));
const HTML_1 = '<p id="p7">Seventh paragraph.</p><p id="p8">Eighth paragraph.</p>';

const docOf = (html: string) =>
  new DOMParser().parseFromString(
    `<!DOCTYPE html><html lang="en"><body>${html}</body></html>`,
    'text/html',
  );

const book = {
  sections: [
    { mediaOverlay: { href: 'OEBPS/ch0.smil', id: 's0' } },
    { mediaOverlay: { href: 'OEBPS/ch1.smil', id: 's1' } },
  ],
  loadText: vi.fn(async (href: string) => (href.endsWith('ch0.smil') ? SMIL_0 : SMIL_1)),
  loadBlob: vi.fn(async () => new Blob([new Uint8Array(8)])),
} as unknown as BookDoc;

// The controller surface the client talks to. Like the real one, a mark
// dispatch moves the text cursor and highlights (setMark), asks the view to
// follow (recorded here), and publishes the position with its section index.
class FakeController extends EventTarget {
  sectionIndex = 0;
  stopAtChapterEnd = false;
  view: { tts: MediaOverlayTTS | null } = { tts: null };
  highlights: string[] = [];
  follows: string[] = [];
  dispatchSpeakMark = (mark?: { name: string }) => {
    if (!mark) return null;
    this.view.tts?.setMark(mark.name);
    this.follows.push(mark.name);
    this.dispatchEvent(
      new CustomEvent('tts-position', { detail: { sectionIndex: this.sectionIndex } }),
    );
    return null;
  };
  enterSection(index: number, doc: Document, section: MediaOverlaySection): MediaOverlayTTS {
    this.sectionIndex = index;
    this.view.tts = new MediaOverlayTTS(doc, section, (range) => {
      this.highlights.push(range.toString());
    });
    return this.view.tts;
  }
}

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

// Settle the promise chains the client runs on native events. Microtasks only:
// the fake timers stay frozen, as a hidden page's would.
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

let controller: FakeController;
let client: MediaOverlayClient;
let doc0: Document;
let section0: MediaOverlaySection;
let events: TTSMessageEvent[];
let player: InstanceType<typeof FakeNativePlayer>;

// Every utterance a test starts is aborted after it, so a suspended one cannot
// react to the next test's visibility changes.
let utterances: AbortController[] = [];
const speak = (ssml: string): Promise<void> => {
  const controller = new AbortController();
  utterances.push(controller);
  const sink = events;
  return (async () => {
    for await (const event of client.speak(ssml, controller.signal)) sink.push(event);
  })();
};

// Start section 0 from its first block and let the first word become audible.
// Returns the utterance's completion wrapped, so awaiting this does not wait
// for the utterance itself.
const startSection0 = async (): Promise<{ running: Promise<void> }> => {
  const tts = controller.enterSection(0, doc0, section0);
  const running = speak(tts.start()!);
  await flush();
  player = FakeNativePlayer.last!;
  return { running };
};

// Put the page into the background mid-block and wait for the client to go quiet.
const lockScreen = async () => {
  setVisibility('hidden');
  await flush();
  player.calls = [];
  controller.follows = [];
  controller.highlights = [];
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  events = [];
  utterances = [];
  doc0 = docOf(HTML_0);
  section0 = (await loadMediaOverlaySection(book, 0, doc0, 'en'))!;
  controller = new FakeController();
  client = new MediaOverlayClient(controller as unknown as TTSController);
  await client.init();
  client.attachBook(book);
  client.setSection(section0);
});

afterEach(async () => {
  for (const utterance of utterances) utterance.abort();
  await flush();
  await client.shutdown();
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('MediaOverlayClient with the screen off (Android)', () => {
  test('plays through three block boundaries and a file change with no pause, timer or redraw', async () => {
    await startSection0();
    expect(controller.follows).toEqual(['0']);

    await lockScreen();
    // The playhead crosses p1 -> p2 -> p3 -> p4 in a.mp3 with no timer firing.
    player.time = 8.5;
    await flush();
    expect(events.map((e) => e.code)).toEqual(['boundary']);

    // a.mp3 runs out: the native 'ended' event alone moves playback into b.mp3.
    player.fireEnded();
    await flush();

    expect(player.calls).toEqual(['load:OEBPS/b.mp3', 'seek:0', 'play']);
    expect(player.calls).not.toContain('pause');
    expect(controller.follows).toEqual([]);
    expect(controller.highlights).toEqual([]);
    // Still one utterance: the controller was never asked to advance a block.
    expect(events.map((e) => e.code)).toEqual(['boundary']);
    // Nothing waits on a timer while hidden, the handover grace included.
    expect(vi.getTimerCount()).toBe(0);
  });

  test('on unlock, lands one follow and one highlight on the sentence the native player is in', async () => {
    const { running } = await startSection0();
    await lockScreen();
    player.fireEnded();
    await flush();

    // Two seconds into b.mp3 is p6, mark 7.
    player.time = 2.5;
    player.calls = [];
    setVisibility('visible');
    await flush();

    expect(controller.follows).toEqual(['7']);
    expect(controller.highlights).toEqual(['Sixth paragraph.']);
    expect(player.calls).toEqual(['refresh']);
    // The controller's cursor is on p6, so its next step is the block after it.
    expect(controller.view.tts!.getLastRange()!.toString()).toBe('Sixth paragraph.');

    // Visible again, the block finishes on the normal clock path.
    player.time = 4;
    await vi.advanceTimersByTimeAsync(50);
    await running;
    expect(events.map((e) => e.code)).toEqual(['boundary', 'boundary', 'end']);
  });

  test('rapid lock/unlock toggles resync exactly once, after the last unlock', async () => {
    await startSection0();
    await lockScreen();
    player.time = 5.5;

    // Toggled back off while the position read is in flight: nothing is drawn.
    player.holdNextRefresh();
    setVisibility('visible');
    await flush();
    setVisibility('hidden');
    player.releaseRefresh();
    await flush();
    expect(controller.follows).toEqual([]);

    // A burst of toggles ending visible resolves once, at p3 (mark 4).
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    await flush();

    expect(controller.follows).toEqual(['4']);
    expect(controller.highlights).toEqual(['Third paragraph.']);
  });

  test('crosses into the next chapter while hidden, then walks the controller to it on unlock', async () => {
    await startSection0();
    await lockScreen();
    player.fireEnded(); // a.mp3 -> b.mp3
    await flush();
    player.fireEnded(); // b.mp3 was section 0's last file -> section 1's c.mp3
    await flush();

    expect(player.calls).toEqual([
      'load:OEBPS/b.mp3',
      'seek:0',
      'play',
      'load:OEBPS/c.mp3',
      'seek:0',
      'play',
    ]);
    expect(controller.follows).toEqual([]);
    expect(controller.highlights).toEqual([]);

    // Unlock four seconds into c.mp3 (section 1's p8).
    player.time = 4;
    player.calls = [];
    setVisibility('visible');
    await flush();

    // Section 0's utterance ends with the cursor parked on its last block, so
    // the controller's next step loads section 1. Audio keeps rolling.
    expect(events.at(-1)?.code).toBe('end');
    expect(controller.view.tts!.next()).toBeUndefined();
    expect(player.calls).not.toContain('pause');
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.follows).toEqual([]);

    // The controller enters section 1 and speaks its first block; the client
    // resumes at the par under the playhead instead of the block start.
    const doc1 = docOf(HTML_1);
    const section1 = (await loadMediaOverlaySection(book, 1, doc1, 'en'))!;
    client.setSection(section1);
    const tts1 = controller.enterSection(1, doc1, section1);
    const ssml = tts1.start()!;
    player.calls = [];
    // As TTSController#speak does it: dispatch the utterance's first mark (p7,
    // a sentence the recording is past), then call speak().
    controller.dispatchSpeakMark({ name: parseSSMLMarks(ssml).marks[0]!.name });
    speak(ssml);
    await flush();

    // One follow and one highlight, both on p8; the stale p7 never lands.
    expect(controller.follows).toEqual(['1']);
    expect(controller.highlights).toEqual(['Eighth paragraph.']);
    expect(player.calls).not.toContain('seek:0');
    expect(player.calls).not.toContain('pause');

    // Caught up: the controller's own dispatches land again.
    controller.dispatchSpeakMark({ name: '0' });
    expect(controller.follows).toEqual(['1', '0']);
  });
});

describe('MediaOverlayClient handover grace with the screen off (Android)', () => {
  // Finish section 0's first block on screen: the element is left rolling for
  // the next block and the one-second handover grace is armed.
  const finishFirstBlockOnScreen = async () => {
    const { running } = await startSection0();
    player.time = 3;
    await vi.advanceTimersByTimeAsync(50);
    await running;
    expect(events.at(-1)?.code).toBe('end');
    expect(player.paused).toBe(false);
  };

  test('a grace armed on screen that runs out after the lock does not pause narration', async () => {
    await finishFirstBlockOnScreen();
    setVisibility('hidden');
    await flush();
    player.calls = [];

    await vi.advanceTimersByTimeAsync(5000);
    expect(player.calls).not.toContain('pause');
    expect(player.paused).toBe(false);

    // Back on screen with nothing having claimed the element: the watchdog
    // restarts its grace from here and still silences it.
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(999);
    expect(player.calls).not.toContain('pause');
    await vi.advanceTimersByTimeAsync(1);
    expect(player.calls).toEqual(['pause']);
  });

  test('a next block that claims the element while locked cancels the grace for good', async () => {
    await finishFirstBlockOnScreen();
    setVisibility('hidden');
    await flush();

    // The controller's next utterance (p2) arrives with the screen off.
    speak(section0.ssmlForBlock(1)!);
    await flush();
    player.calls = [];

    setVisibility('visible');
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(player.calls).not.toContain('pause');
    expect(controller.follows.at(-1)).toBe('3');
  });
});

describe('TTSController with the screen off (Android)', () => {
  // The real controller over a two-section paginated view, both sections
  // rendered (the multiview paginator keeps the adjacent one alive), with
  // every mark and highlight cfi it produces recorded.
  //
  // `renderLog` records what reaches the screen, in order. The view side is a
  // stand-in for useTTSControl's two navigation handlers: handleSectionChange
  // (the controller's onSectionChange) turns to a section start with
  // renderer.goTo, logged 'section:<index>'; handleHighlightMark follows a
  // highlight cfi, with view.goTo(cfi) when it is in another section than the
  // primary view ('goTo:<cfi>') and renderer.scrollToAnchor when it is not
  // ('scroll:<cfi>'). A navigation relocates the view, and the relocate
  // re-applies the controller's highlight, as useTTSControl's progress effect
  // does. Overlay writes log 'draw:<section>:<text>', and 'clear:<section>'
  // when a drawn highlight is removed.
  const realController = () => {
    const docs = [docOf(HTML_0), docOf(HTML_1)];
    const renderLog: string[] = [];
    const ranges = new Map<string, Range>();
    const contents = docs.map((doc, index) => {
      let drawn = false;
      const overlayer = {
        add: (_key: string, range: Range) => {
          drawn = true;
          renderLog.push(`draw:${index}:${range.toString()}`);
        },
        remove: (key: string) => {
          if (key !== 'tts-highlight' || !drawn) return;
          drawn = false;
          renderLog.push(`clear:${index}`);
        },
      };
      return { doc, index, overlayer };
    });
    const renderer = { getContents: () => contents, primaryIndex: 0, scrolled: false };
    const view = {
      book: {
        sections: book.sections!.map((section, index) => ({
          ...section,
          id: `s${index}`,
          createDocument: async () => docs[index],
        })),
        loadText: book.loadText,
        loadBlob: book.loadBlob,
      },
      renderer,
      language: { isCJK: false, canonical: 'en' },
      getCFI: (index: number, range?: Range) => {
        const cfi = `${index}:${range?.toString() ?? ''}`;
        if (range) ranges.set(cfi, range);
        return cfi;
      },
      resolveCFI: (cfi: string) => ({
        index: Number(cfi.split(':')[0]),
        anchor: () => ranges.get(cfi) ?? null,
      }),
      tts: null,
    } as unknown as FoliateView;
    const sectionLoads: number[] = [];
    // Scheduled like a relocate: after the navigation, never inside it.
    const relocate = (index: number) => {
      renderer.primaryIndex = index;
      queueMicrotask(() => tts.reapplyCurrentHighlight());
    };
    const tts = new TTSController(null, view, false, undefined, async (index) => {
      sectionLoads.push(index);
      renderLog.push(`section:${index}`);
      relocate(index);
    });
    const marks: string[] = [];
    const follows: string[] = [];
    tts.addEventListener('tts-speak-mark', (event) => {
      const name = (event as CustomEvent<{ name?: string }>).detail.name;
      if (name) marks.push(name);
    });
    tts.addEventListener('tts-highlight-mark', (event) => {
      const { cfi } = (event as CustomEvent<{ cfi: string }>).detail;
      follows.push(cfi);
      const index = Number(cfi.split(':')[0]);
      if (index !== renderer.primaryIndex) {
        renderLog.push(`goTo:${cfi}`);
        relocate(index);
      } else {
        renderLog.push(`scroll:${cfi}`);
      }
    });
    return { tts, renderLog, sectionLoads, marks, follows };
  };

  // Its own speak path dispatches each utterance's first mark before the
  // client runs; the page must still move once, to the sentence the recording
  // is on.
  test('a chapter crossed while locked lands one navigation, straight to the sentence sounding, then its highlight', async () => {
    const { tts, renderLog, sectionLoads, marks, follows } = realController();
    try {
      await tts.init();
      expect(tts.narrationActive).toBe(true);
      await tts.start();
      await flush();
      const native = FakeNativePlayer.last!;
      expect(follows.at(-1)).toBe('0:Alpha');
      expect(renderLog.at(-1)).toBe('scroll:0:Alpha');

      setVisibility('hidden');
      await flush();
      renderLog.length = 0;
      native.fireEnded(); // a.mp3 -> b.mp3
      await flush();
      native.fireEnded(); // -> section 1's c.mp3
      await flush();
      expect(native.calls).toContain('load:OEBPS/c.mp3');

      // Nothing drawn, cleared or navigated while locked, the crossing included.
      expect(renderLog).toEqual([]);
      marks.length = 0;
      follows.length = 0;
      renderLog.length = 0;
      native.calls = [];
      native.time = 4; // section 1's p8, mark 1
      setVisibility('visible');
      for (let i = 0; i < 10; i++) await flush();

      // The controller walked into section 1 without turning to its start: one
      // view.goTo, to p8's cfi, then p8's highlight, and only then is section
      // 0's old highlight cleared (off screen by now).
      expect(sectionLoads).toEqual([]);
      expect(renderLog).toEqual([
        'goTo:1:Eighth paragraph.',
        'draw:1:Eighth paragraph.',
        'clear:0',
      ]);
      expect(marks).toEqual(['1']);
      expect(follows).toEqual(['1:Eighth paragraph.']);
      expect(native.calls).not.toContain('seek:0');
      expect(native.calls).not.toContain('pause');
    } finally {
      await tts.stop();
      await tts.ttsMediaOverlayClient.shutdown();
    }
  });

  // A headset "next" with the screen off goes through TTSController.forward(),
  // whose speak path dispatches the new block's first mark before the client
  // is called at all.
  test('a block the controller starts while locked draws nothing, then lands once on unlock', async () => {
    const { tts, marks, follows } = realController();
    try {
      await tts.init();
      await tts.start();
      await flush();
      const native = FakeNativePlayer.last!;
      expect(follows.at(-1)).toBe('0:Alpha');

      setVisibility('hidden');
      await flush();
      marks.length = 0;
      follows.length = 0;
      await tts.forward();
      for (let i = 0; i < 5; i++) await flush();

      // The lock screen still hears about the new block (p2, mark 3), but the
      // page is neither highlighted nor asked to follow.
      expect(marks).toEqual(['3']);
      expect(follows).toEqual([]);
      expect(tts.state).toBe('playing');

      // Unlocked partway into p3 (a.mp3 5-7s, mark 4): one landing, there.
      native.time = 5.5;
      native.calls = [];
      setVisibility('visible');
      for (let i = 0; i < 5; i++) await flush();

      expect(follows).toEqual(['0:Third paragraph.']);
      expect(native.calls).not.toContain('pause');
    } finally {
      await tts.stop();
      await tts.ttsMediaOverlayClient.shutdown();
    }
  });

  // The headset "next" reaches #initTTSForSection when the controller's cursor
  // is on the section's last block. That path used to clear the highlights and
  // turn to the new section's start through onSectionChange, locked or not.
  test('a headset next across a chapter while locked turns no page and clears nothing, then lands once on unlock', async () => {
    const { tts, renderLog, sectionLoads, marks, follows } = realController();
    try {
      await tts.init();
      await tts.start();
      await flush();
      const native = FakeNativePlayer.last!;
      expect(renderLog.slice(-2)).toEqual(['draw:0:Alpha', 'scroll:0:Alpha']);

      setVisibility('hidden');
      await flush();
      native.fireEnded(); // a.mp3 -> b.mp3, still section 0
      await flush();
      native.time = 2.5; // p6, section 0's last block
      renderLog.length = 0;
      marks.length = 0;
      follows.length = 0;
      native.calls = [];

      await tts.forward();
      for (let i = 0; i < 10; i++) await flush();

      // Narration moved into section 1: its first block (p7, mark 0) is loaded
      // and playing, and the lock screen hears about it.
      expect(native.calls).toContain('load:OEBPS/c.mp3');
      expect(native.paused).toBe(false);
      expect(marks).toEqual(['0']);
      expect(tts.state).toBe('playing');
      // Nothing reached the page: no section turn, no goTo, no highlight
      // cleared or drawn.
      expect(sectionLoads).toEqual([]);
      expect(follows).toEqual([]);
      expect(renderLog).toEqual([]);

      native.time = 4; // section 1's p8, mark 1
      native.calls = [];
      setVisibility('visible');
      for (let i = 0; i < 10; i++) await flush();

      expect(sectionLoads).toEqual([]);
      expect(renderLog).toEqual([
        'goTo:1:Eighth paragraph.',
        'draw:1:Eighth paragraph.',
        'clear:0',
      ]);
      expect(native.calls).not.toContain('pause');
    } finally {
      await tts.stop();
      await tts.ttsMediaOverlayClient.shutdown();
    }
  });

  // Paused, no speak() runs to land the new position on unlock: the section's
  // first mark is held while locked and replayed once on unlock.
  test('a skip across a chapter while paused and locked lands once on unlock', async () => {
    const { tts, renderLog, sectionLoads, follows } = realController();
    try {
      await tts.init();
      await tts.start();
      await flush();
      await tts.pause();
      // On screen, walk the cursor to section 0's last block (p6).
      for (let i = 0; i < 5; i++) await tts.forward();
      await flush();
      expect(follows.at(-1)).toBe('0:Sixth paragraph.');

      setVisibility('hidden');
      await flush();
      renderLog.length = 0;
      follows.length = 0;

      await tts.forward();
      await flush();
      expect(sectionLoads).toEqual([]);
      expect(follows).toEqual([]);
      expect(renderLog).toEqual([]);

      setVisibility('visible');
      await flush();
      expect(sectionLoads).toEqual([]);
      expect(renderLog).toEqual([
        'goTo:1:Seventh paragraph.',
        'draw:1:Seventh paragraph.',
        'clear:0',
      ]);
    } finally {
      await tts.stop();
      await tts.ttsMediaOverlayClient.shutdown();
    }
  });

  // useTTSControl's sentence page-follow interval turns the page when
  // getSentenceProgress() passes the page break, and stops itself on null. An
  // interval armed on screen keeps ticking (throttled) after the lock, so the
  // progress it reads must go null there.
  test('sentence progress reads null while locked, so an armed page-follow stops instead of turning', async () => {
    const { tts } = realController();
    try {
      await tts.init();
      await tts.start();
      await flush();
      const native = FakeNativePlayer.last!;
      native.time = 0.5;
      expect(tts.getSentenceProgress()).toBeCloseTo(0.5);

      setVisibility('hidden');
      await flush();
      native.time = 0.9;
      expect(tts.getSentenceProgress()).toBeNull();
    } finally {
      await tts.stop();
      await tts.ttsMediaOverlayClient.shutdown();
    }
  });
});

describe('MediaOverlayClient with the screen off (sleep timer)', () => {
  test('"stop at end of chapter" stops at the section boundary instead of coasting past it', async () => {
    controller.stopAtChapterEnd = true;
    await startSection0();
    await lockScreen();
    player.fireEnded(); // a.mp3 -> b.mp3, same section
    await flush();
    player.fireEnded(); // end of the chapter's audio
    await flush();

    expect(player.calls).not.toContain('load:OEBPS/c.mp3');
    expect(events.at(-1)).toEqual({ code: 'end', message: 'Narration finished' });
    // Parked on the chapter's last block: the controller's boundary logic takes over.
    expect(controller.view.tts!.next()).toBeUndefined();
    expect(controller.follows).toEqual([]);
  });
});

describe('MediaOverlayClient with the screen off (desktop and web)', () => {
  class FakeAudio {
    src = '';
    playbackRate = 1;
    preservesPitch = true;
    paused = true;
    currentTime = 0;
    addEventListener(): void {}
    removeEventListener(): void {}
    async play(): Promise<void> {
      this.paused = false;
    }
    pause(): void {
      this.paused = true;
    }
  }

  test('keeps the HTMLAudioElement path as it was: marks still dispatch while hidden', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    vi.stubGlobal('Audio', FakeAudio);
    try {
      // Its own controller: the Android client built in beforeEach gates marks
      // on the shared one, and a platform never runs both clients.
      controller = new FakeController();
      const web = new MediaOverlayClient(controller as unknown as TTSController);
      await web.init();
      web.attachSource({
        loadBlob: async () => new Blob([new Uint8Array(8)]),
        resolveUrl: async () => 'file:///a.mp3',
      });
      web.setSection(section0);
      controller.enterSection(0, doc0, section0);
      setVisibility('hidden');

      const iter = web.speak(section0.ssmlForBlock(1)!, new AbortController().signal);
      expect((await iter.next()).value).toEqual({
        code: 'boundary',
        mark: '3',
        message: 'narration',
      });
      expect(controller.follows).toEqual(['3']);
      await web.shutdown();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
