import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/image', () => ({
  fetchImageAsBase64: vi.fn().mockResolvedValue('data:image/jpeg;base64,cover'),
}));

vi.mock('@/services/tts/carPlaySession', () => ({
  notifyCarPlayState: vi.fn().mockResolvedValue(undefined),
}));

import { TTSMediaBridge, type TTSMediaBridgeMeta } from '@/services/tts/ttsMediaBridge';
import { fetchImageAsBase64 } from '@/utils/image';
import { TauriMediaSession } from '@/libs/mediaSession';
import type { TTSController } from '@/services/tts/TTSController';

class FakeController extends EventTarget {
  state = 'playing';
  terminated = false;
  pause = vi.fn().mockResolvedValue(true);
  start = vi.fn().mockResolvedValue(undefined);
  forward = vi.fn().mockResolvedValue(undefined);
  backward = vi.fn().mockResolvedValue(undefined);
  seekToTime = vi.fn().mockResolvedValue(undefined);
  ensureTimeline = vi.fn().mockResolvedValue(null);
  getPlaybackInfo = vi.fn().mockReturnValue({ position: 12, duration: 80, measuredFraction: 1 });

  emitMark(text: string, name: string) {
    this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: { text, name } }));
  }
}

class FakeMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; type?: string }[];
  constructor(init: {
    title: string;
    artist: string;
    album: string;
    artwork?: { src: string; type?: string }[];
  }) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
    this.artwork = init.artwork ?? [];
  }
}

interface FakeWebMediaSession {
  metadata: FakeMediaMetadata | null;
  playbackState: string;
  handlers: Map<string, (details: MediaSessionActionDetails) => void>;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
}

const makeFakeMediaSession = (): FakeWebMediaSession & { metadataWrites: number } => {
  const handlers = new Map<string, (details: MediaSessionActionDetails) => void>();
  const session = {
    metadata: null as FakeMediaMetadata | null,
    metadataWrites: 0,
    playbackState: 'none',
    handlers,
    setActionHandler: vi.fn(
      (action: string, cb: ((d: MediaSessionActionDetails) => void) | null) => {
        if (cb) handlers.set(action, cb);
        else handlers.delete(action);
      },
    ),
    setPositionState: vi.fn(),
  };
  let current: FakeMediaMetadata | null = null;
  Object.defineProperty(session, 'metadata', {
    configurable: true,
    get: () => current,
    set: (value: FakeMediaMetadata | null) => {
      session.metadataWrites += 1;
      current = value;
    },
  });
  return session;
};

const meta = (overrides: Partial<TTSMediaBridgeMeta> = {}): TTSMediaBridgeMeta => ({
  bookKey: 'hash-abc',
  title: 'Alice',
  author: 'Carroll',
  coverImageUrl: 'cover.jpg',
  metadataMode: 'sentence',
  ...overrides,
});

vi.stubGlobal('MediaMetadata', FakeMediaMetadata);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TTSMediaBridge recorded narration', () => {
  let controller: FakeController;
  let fake: ReturnType<typeof makeFakeMediaSession>;
  let bridge: TTSMediaBridge;
  let sectionLabel: string;

  beforeEach(() => {
    vi.mocked(fetchImageAsBase64).mockReset();
    vi.mocked(fetchImageAsBase64).mockResolvedValue('data:image/jpeg;base64,cover');
    controller = new FakeController();
    fake = makeFakeMediaSession();
    bridge = new TTSMediaBridge(() => fake as unknown as MediaSession);
    sectionLabel = 'Chapter 1';
  });

  const bindNarration = (overrides: Partial<TTSMediaBridgeMeta> = {}) =>
    bridge.bind(controller as unknown as TTSController, {
      ...meta({ metadataMode: 'sentence', narration: true }),
      getSectionLabel: () => sectionLabel,
      ...overrides,
    });

  test('names the book, chapter, and author, and keeps the cover', async () => {
    await bindNarration();
    controller.emitMark('The queen walked on.', '0');
    await flush();

    const metadata = fake.metadata as FakeMediaMetadata;
    expect(metadata.title).toBe('Alice');
    expect(metadata.artist).toBe('Chapter 1');
    expect(metadata.album).toBe('Carroll');
    expect(metadata.artwork[0]?.src).toBe('data:image/jpeg;base64,cover');
    expect(metadata.artwork[0]?.src).not.toBe('');
  });

  test('falls back to the author when the chapter label is empty', async () => {
    sectionLabel = '';
    await bindNarration({ metadataMode: 'paragraph' });
    controller.emitMark('A sentence that must not become the title.', '4');
    await flush();

    const metadata = fake.metadata as FakeMediaMetadata;
    expect(metadata.title).toBe('Alice');
    expect(metadata.artist).toBe('Carroll');
    expect(metadata.album).toBe('Carroll');
  });

  test('does not refresh metadata on a sentence change, and does once on a chapter change', async () => {
    await bindNarration({ metadataMode: 'paragraph' });
    controller.getPlaybackInfo.mockReturnValue({
      position: 10,
      duration: 100,
      measuredFraction: 1,
    });
    controller.emitMark('First sentence.', '0');
    await flush();
    expect(fake.metadataWrites).toBe(1);
    expect(fake.setPositionState).toHaveBeenCalledWith({
      duration: 100,
      position: 10,
      playbackRate: 1,
    });

    controller.getPlaybackInfo.mockReturnValue({
      position: 25,
      duration: 100,
      measuredFraction: 1,
    });
    controller.emitMark('Second sentence.', '3');
    await flush();
    expect(fake.metadataWrites).toBe(1);
    expect((fake.metadata as FakeMediaMetadata).title).toBe('Alice');
    expect(fake.setPositionState).toHaveBeenCalledWith({
      duration: 100,
      position: 25,
      playbackRate: 1,
    });

    sectionLabel = 'Chapter 2';
    controller.getPlaybackInfo.mockReturnValue({ position: 1, duration: 50, measuredFraction: 1 });
    controller.emitMark('Opening of the next chapter.', '2');
    await flush();
    expect(fake.metadataWrites).toBe(2);
    expect((fake.metadata as FakeMediaMetadata).title).toBe('Alice');
    expect((fake.metadata as FakeMediaMetadata).artist).toBe('Chapter 2');
    expect((fake.metadata as FakeMediaMetadata).album).toBe('Carroll');
    expect(fake.setPositionState).toHaveBeenCalledWith({
      duration: 50,
      position: 1,
      playbackRate: 1,
    });
  });

  test('maps all four skip actions to the previous or next sentence, and seekto to seekToTime', async () => {
    await bindNarration();
    fake.handlers.get('seekbackward')!({} as MediaSessionActionDetails);
    fake.handlers.get('previoustrack')!({} as MediaSessionActionDetails);
    expect(controller.backward).toHaveBeenNthCalledWith(1, true);
    expect(controller.backward).toHaveBeenNthCalledWith(2, true);

    fake.handlers.get('seekforward')!({} as MediaSessionActionDetails);
    fake.handlers.get('nexttrack')!({} as MediaSessionActionDetails);
    expect(controller.forward).toHaveBeenNthCalledWith(1, true);
    expect(controller.forward).toHaveBeenNthCalledWith(2, true);

    fake.handlers.get('seekto')!({ seekTime: 42 } as MediaSessionActionDetails);
    expect(controller.seekToTime).toHaveBeenCalledWith(42);
  });

  test('native seekto still converts milliseconds into seekToTime', async () => {
    class RecordingTauriSession extends TauriMediaSession {
      actions = new Map<string, ((position: number) => void) | (() => void)>();
      override setActionHandler(
        action: string,
        handler: (() => void) | ((position: number) => void) | null,
      ) {
        if (handler) this.actions.set(action, handler);
        else this.actions.delete(action);
      }
      override async setActive() {}
      override async updateMetadata() {}
      override async updatePlaybackState() {}
    }
    const tauriSession = new RecordingTauriSession();
    bridge = new TTSMediaBridge(() => tauriSession as unknown as MediaSession);
    await bindNarration();
    const seekto = tauriSession.actions.get('seekto') as (positionMs: number) => void;
    seekto(42000);
    expect(controller.seekToTime).toHaveBeenCalledWith(42);
  });

  test('native narration metadata uses the cover and never an empty artwork string', async () => {
    class RecordingTauriSession extends TauriMediaSession {
      payloads: { title: string; artist: string; album: string; artwork?: string }[] = [];
      override setActionHandler() {}
      override async setActive() {}
      override async updateMetadata(payload: {
        title: string;
        artist: string;
        album: string;
        artwork?: string;
      }) {
        this.payloads.push(payload);
      }
      override async updatePlaybackState() {}
    }
    const tauriSession = new RecordingTauriSession();
    bridge = new TTSMediaBridge(() => tauriSession as unknown as MediaSession);
    await bindNarration();
    expect(tauriSession.payloads[0]).toEqual({
      title: 'Alice',
      artist: 'Chapter 1',
      album: 'Carroll',
      artwork: 'data:image/jpeg;base64,cover',
    });

    vi.mocked(fetchImageAsBase64).mockRejectedValue(new Error('no cover'));
    const bare = new RecordingTauriSession();
    const bareBridge = new TTSMediaBridge(() => bare as unknown as MediaSession);
    await bareBridge.bind(new FakeController() as unknown as TTSController, {
      ...meta({ narration: true, coverImageUrl: null }),
      getSectionLabel: () => 'Chapter 1',
    });
    expect(bare.payloads[0]?.artwork).toBeUndefined();
    expect(bare.payloads.some((payload) => payload.artwork === '')).toBe(false);
  });
});

describe('TTSMediaBridge synthetic sessions', () => {
  let controller: FakeController;
  let fake: ReturnType<typeof makeFakeMediaSession>;
  let bridge: TTSMediaBridge;

  beforeEach(() => {
    vi.mocked(fetchImageAsBase64).mockReset();
    vi.mocked(fetchImageAsBase64).mockResolvedValue('data:image/jpeg;base64,cover');
    controller = new FakeController();
    fake = makeFakeMediaSession();
    bridge = new TTSMediaBridge(() => fake as unknown as MediaSession);
  });

  test('still names each sentence and steps paragraphs from the track buttons', async () => {
    await bridge.bind(controller as unknown as TTSController, {
      ...meta(),
      getSectionLabel: () => 'Chapter 1',
    });

    controller.emitMark('First sentence.', '0');
    await flush();
    controller.emitMark('Second sentence.', '1');
    await flush();

    expect(fake.metadataWrites).toBe(2);
    expect((fake.metadata as FakeMediaMetadata).title).toBe('Second sentence.');
    expect((fake.metadata as FakeMediaMetadata).artist).toBe('Chapter 1');
    expect((fake.metadata as FakeMediaMetadata).album).toBe('Carroll');

    fake.handlers.get('nexttrack')!({} as MediaSessionActionDetails);
    fake.handlers.get('previoustrack')!({} as MediaSessionActionDetails);
    expect(controller.forward).toHaveBeenCalledTimes(1);
    expect(controller.forward).toHaveBeenCalledWith();
    expect(controller.backward).toHaveBeenCalledTimes(1);
    expect(controller.backward).toHaveBeenCalledWith();

    fake.handlers.get('seekforward')!({} as MediaSessionActionDetails);
    fake.handlers.get('seekbackward')!({} as MediaSessionActionDetails);
    expect(controller.forward).toHaveBeenLastCalledWith(true);
    expect(controller.backward).toHaveBeenLastCalledWith(true);
  });
});
