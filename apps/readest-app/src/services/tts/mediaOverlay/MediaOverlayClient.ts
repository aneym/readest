// Plays the book's own recorded narration in place of synthesized speech.
//
// A TTSClient normally turns SSML into audio. This one turns SSML back into the
// SMIL pars it came from (marks are par ordinals) and plays their clips off a
// single media clock, reporting a boundary as each par becomes audible.
// Everything above it — transport, highlighting, scrubber, media session — is
// unchanged, which is the point.
//
// A block plays as one continuous span rather than clip-by-clip: consecutive
// pars in a paragraph are contiguous audio, and re-seeking between them would
// put an audible seam in the middle of a narrated sentence.
//
// On mobile Tauri the clock is an in-process native player
// (NativeNarrationPlayer). iOS needs it so TTSMediaBridge and narration share
// one playback session; Android needs it so multi-hour local files can stream
// from disk without buffering the whole audiobook through the WebView.
// Desktop and web use a plain HTMLAudioElement.
//
// With the screen off (native only) the WebView's timers are throttled to once
// a second, then once a minute, and it draws no frames. So while the page is
// hidden the client stops walking pars on a timer: it lets the native player
// run straight on through blocks, advances to the next audio file (and into the
// next section) from the native 'ended' event, and asks for no highlight or
// page turn. When the page is visible again it reads the native position,
// resolves the par now sounding, and lands one navigation and one highlight on
// it.

import type { BookDoc } from '@/libs/document';
import { getOSPlatform, stubTranslation as _ } from '@/utils/misc';
import { parseSSMLMarks } from '@/utils/ssml';
import type { TTSCapabilities, TTSClient, TTSMessageEvent } from '../TTSClient';
import type { TTSController } from '../TTSController';
import type { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from '../types';
import type { MediaOverlaySection, NarrationPar } from './MediaOverlaySection';
import { NativeNarrationPlayer } from './NativeNarrationPlayer';
import { isNarrationHidden, onNarrationVisibility } from './narrationVisibility';
import { parseSmil } from './parseSmil';

export const MEDIA_OVERLAY_CLIENT_NAME = 'media-overlay';
export const MEDIA_OVERLAY_VOICE_ID = 'media-overlay';

// Polling backstop for the media clock. 'timeupdate' alone fires only ~4x/sec,
// too coarse for word-level narration; the interval keeps boundaries tight in
// the foreground while 'timeupdate' and 'ended' keep them arriving when timers
// are throttled with the screen off.
const CLOCK_POLL_MS = 50;

type WaitOutcome = 'reached' | 'ended' | 'aborted' | 'error' | 'hidden';

// How far the playhead may sit from a clip's start and still count as "already
// rolling into it" rather than needing a seek. Covers the few milliseconds that
// polling overshoots a clip end by, plus pause/resume latency, while staying
// under the length of even a word-level clip.
const CLIP_CONTINUITY_TOLERANCE_SEC = 0.3;

// How long the element may keep playing after a block ends while waiting for the
// next block to claim it. Long enough that a normal handover is never cut short,
// short enough that narration can never be left running unattended.
const HANDOVER_GRACE_MS = 1000;

// How far past a section's last clip the playhead may sit in the same file and
// still be that section's trailing silence, rather than the next section
// already playing out of a shared file.
const SECTION_TAIL_SLACK_SEC = 1.5;

// Cap on sections the controller is walked through to catch up with audio that
// ran on past them while the screen was off. Ten minutes rarely crosses more
// than one or two; the cap only stops a bad mapping from paging the whole book.
const MAX_RESYNC_STEPS = 32;

// Inline of isTauriAppPlatform(): importing @/services/environment pulls the
// app-service graph into unit tests that only need the platform bit.
const isNativeNarrationPlatform = (): boolean =>
  ['android', 'ios'].includes(getOSPlatform()) &&
  process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';

// Container blobs come out of the zip with no MIME type, and a media element
// given a typeless blob URL refuses to decode it ("Format error"), so the type
// has to be supplied from the file name. Covers the formats EPUB Media Overlays
// audio realistically uses.
const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

const audioBlobWithType = (href: string, blob: Blob): Blob => {
  if (blob.type) return blob;
  const ext = href.split('.').pop()?.toLowerCase() ?? '';
  return new Blob([blob], { type: AUDIO_MIME_TYPES[ext] ?? 'audio/mpeg' });
};

interface ClipRun {
  audioHref: string;
  pars: NarrationPar[];
}

interface Clip {
  audioHref: string;
  clipBegin: number;
  clipEnd: number;
}

// Where the recording is while the screen is off: the clip list of the section
// it is in, which is past the controller's section once it crossed one.
interface CoastPlace {
  clips: Clip[];
  sectionIndex: number;
  crossed: boolean;
}

type CoastOutcome = 'visible' | 'finished' | 'aborted' | 'error';

// Set when the recording ran past the controller's section while hidden.
// `target` identifies the section the audio is in by its clips, when hidden
// playback crossed into it; null means the walk stops at the first section
// the playhead lands in. By clips rather than spine index: the controller's
// walk announces its section only through the mark dispatches the resync
// holds back, and no two sections share a clip.
interface Resync {
  target: Set<string> | null;
  steps: number;
}

const clipKey = (clip: Clip): string => `${clip.audioHref}#${clip.clipBegin}-${clip.clipEnd}`;

type PlayResult = { kind: 'done' } | { kind: 'stop' } | { kind: 'hidden'; ended: boolean };

// The par the playhead is in. 'ahead' means past this section's audio; its par
// is the section's last, where the controller's cursor is parked to move on.
type Located =
  | { kind: 'here'; par: NarrationPar }
  | { kind: 'ahead'; par: NarrationPar }
  | { kind: 'unknown' };

// The controller's text source for narration (MediaOverlayTTS), reached
// through the view so the cursor can be moved without drawing anything.
interface NarrationTextSource {
  section: MediaOverlaySection;
  from(range: Range): string | undefined;
}

export interface NarrationAudioSource {
  narrator?: string;
  textHighlight?: boolean;
  loadBlob: (href: string) => Promise<Blob>;
  resolveUrl?: (href: string) => Promise<string | null>;
  resolvePath?: (href: string) => Promise<string | null>;
}

// Minimal clock surface shared by HTMLAudioElement and NativeNarrationPlayer.
interface NarrationClock {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended' | 'error' | 'timeupdate', fn: () => void): void;
  removeEventListener(type: 'ended' | 'error' | 'timeupdate', fn: () => void): void;
}

// Consecutive pars sharing an audio file. Normally one run per block; a run
// boundary means the publisher split the paragraph across files.
const toRuns = (pars: NarrationPar[]): ClipRun[] => {
  const runs: ClipRun[] = [];
  for (const par of pars) {
    const last = runs.at(-1);
    if (last && last.audioHref === par.audioHref) last.pars.push(par);
    else runs.push({ audioHref: par.audioHref, pars: [par] });
  }
  return runs;
};

// Resolve a native playhead (file + seconds) to a par of the section. A file
// the section never plays, or a playhead past the section's last clip in a file
// that carries on, is 'ahead'. `fileEnded` means the file ran out: its last
// par is where the recording stopped.
const locateInSection = (
  pars: NarrationPar[],
  href: string,
  seconds: number,
  fileEnded: boolean,
): Located => {
  const last = pars.at(-1);
  if (!last) return { kind: 'unknown' };
  const inFile = pars.filter((par) => par.audioHref === href);
  if (!inFile.length) return { kind: 'ahead', par: last };
  if (!fileEnded && inFile.at(-1) === last && seconds >= last.clipEnd + SECTION_TAIL_SLACK_SEC) {
    return { kind: 'ahead', par: last };
  }
  let found = inFile[0]!;
  for (const par of inFile) {
    if (par.clipBegin <= seconds) found = par;
  }
  return { kind: 'here', par: found };
};

const STOP: PlayResult = { kind: 'stop' };
const DONE: PlayResult = { kind: 'done' };

export class MediaOverlayClient implements TTSClient {
  name = MEDIA_OVERLAY_CLIENT_NAME;
  initialized = false;
  controller?: TTSController;

  #source: NarrationAudioSource | null = null;
  // The EPUB behind the source, when there is one: hidden playback reads the
  // next sections' SMIL from it to keep going across a chapter boundary.
  #book: BookDoc | null = null;
  // Spine index of the section narrating, from the controller's position
  // signal (a MediaOverlaySection does not carry its index).
  #sectionIndex = -1;
  #section: MediaOverlaySection | null = null;
  #native = isNativeNarrationPlatform();
  #player: NativeNarrationPlayer | null = null;
  #audio: NarrationClock | null = null;
  #audioHref: string | null = null;
  #objectUrl: string | null = null;
  #audioLoad: { href: string; promise: Promise<NarrationClock> } | null = null;
  #currentPar: NarrationPar | null = null;
  #nextChunkPosition: number | null = null;
  #handoverTimer: ReturnType<typeof setTimeout> | null = null;
  // Unsubscribe for a handover watchdog waiting out a hidden page.
  #handoverDeferred: (() => void) | null = null;
  #rate = 1;
  #lang = 'en';
  // True while a hidden page is following the recording from native events.
  #coasting = false;
  // The latest par reached while hidden, never dispatched. Fallback target for
  // the resync if the native position cannot be resolved.
  #queuedPar: NarrationPar | null = null;
  // Set when the recording ran past the controller's section while hidden.
  // Each following utterance either parks the controller at its section's end
  // (to move on) or finds the playhead and resumes there.
  #resync: Resync | null = null;
  // Restores the controller's own dispatchSpeakMark once the mark gate below
  // is lifted.
  #releaseMarks: (() => void) | null = null;
  // The latest controller mark the gate kept off a hidden page (a block the
  // controller started, or a sentence it navigated to, with the screen off).
  #heldMark: TTSMark | null = null;
  // Unsubscribe for the gate's visibility listener (native only).
  #gateVisibility: (() => void) | null = null;

  constructor(controller?: TTSController) {
    this.controller = controller;
    if (typeof controller?.addEventListener === 'function') {
      controller.addEventListener('tts-position', (event) => {
        const index = (event as CustomEvent<{ sectionIndex?: number }>).detail?.sectionIndex;
        if (typeof index === 'number') this.#sectionIndex = index;
      });
    }
  }

  async init(): Promise<boolean> {
    if (this.#native) {
      // Re-entering narration after Edge/system must not orphan the existing
      // player (and its staged chapter file / event listener).
      if (!this.#player) this.#player = new NativeNarrationPlayer();
      this.#installMarkGate();
      this.initialized = true;
      return true;
    }
    this.initialized = typeof Audio !== 'undefined';
    return this.initialized;
  }

  // The book supplies the audio blobs and the narrator's name. Bound once per
  // session, independently of the section, so the voice list can name the
  // narrator before any section has been indexed.
  attachBook(book: BookDoc | null): void {
    this.attachSource(
      book?.loadBlob
        ? {
            narrator: book.media?.narrator,
            loadBlob: (href) => book.loadBlob!(href),
          }
        : null,
    );
    this.#book = book?.loadBlob ? book : null;
  }

  // External audiobook files use the same clock and clip machinery as EPUB
  // Media Overlays; only the blob provider and narrator label differ.
  attachSource(source: NarrationAudioSource | null): void {
    this.#source = source;
    this.#book = null;
    this.#nextChunkPosition = null;
  }

  // The narration index for the section now playing; rebuilt on every section
  // change, since pars are resolved against that section's document.
  setSection(section: MediaOverlaySection | null): void {
    this.#section = section;
  }

  #narratorName(): string {
    return this.#source?.narrator?.trim() || _('Book narration');
  }

  // Concurrent callers share one load. Playback and the controller's
  // preloadNextSSML(4) all ask for the same chapter file at once; without this
  // each built its own element, and each one's #releaseAudio() revoked the
  // previous URL while it was still loading.
  // `keepRolling` skips the pause after a native load: hidden playback plays
  // the new file straight away, and the item is loaded paused anyway.
  async #ensureAudio(href: string, keepRolling = false): Promise<NarrationClock> {
    if (this.#audio && this.#audioHref === href) return this.#audio;
    if (this.#audioLoad?.href === href) return this.#audioLoad.promise;

    const promise = this.#loadAudio(href, keepRolling);
    this.#audioLoad = { href, promise };
    try {
      return await promise;
    } finally {
      if (this.#audioLoad?.promise === promise) this.#audioLoad = null;
    }
  }

  async #loadAudio(href: string, keepRolling = false): Promise<NarrationClock> {
    if (!this.#source) throw new Error('Book cannot load narration audio');

    if (this.#native && this.#player) {
      const path = await this.#source.resolvePath?.(href).catch(() => null);
      // Keep any prior native session's file until the new one is staged; load()
      // replaces the AVPlayer item. Do not call #releaseAudio (that aborts).
      this.#cancelHandover();
      if (path) {
        await this.#player.loadPath(href, path, 0);
      } else {
        const blob = audioBlobWithType(href, await this.#source.loadBlob(href));
        await this.#player.load(href, blob, 0);
      }
      this.#player.playbackRate = this.#rate;
      if (!keepRolling) this.#player.pause();
      this.#audio = this.#player;
      this.#audioHref = href;
      this.#objectUrl = null;
      return this.#player;
    }

    const directUrl = await this.#source.resolveUrl?.(href).catch(() => null);
    this.#releaseAudio();
    let url = directUrl ?? null;
    if (!url) {
      const blob = audioBlobWithType(href, await this.#source.loadBlob(href));
      url = URL.createObjectURL(blob);
      this.#objectUrl = url;
    }
    const audio = new Audio();
    audio.src = url;
    // Speed changes must not raise the narrator's pitch.
    audio.preservesPitch = true;
    audio.playbackRate = this.#rate;
    this.#audio = audio;
    this.#audioHref = href;
    return audio;
  }

  // Leave the element playing for the next block to pick up, but never
  // unattended: if nothing claims it — a one-off selection read, a session torn
  // down without stopping — silence it.
  //
  // Never while the native page is hidden: a throttled timer fires late, and
  // pausing at a block end with the screen off is exactly the gap screen-off
  // narration must not have. Visibility is checked again when the timer fires,
  // since a grace period armed on screen can run out after the lock. Either
  // way the watchdog waits for the page to come back and restarts its grace
  // from there. Not while a resync is pending either: the controller is
  // catching up to audio that must keep rolling.
  #armHandover(audio: NarrationClock): void {
    this.#cancelHandover();
    if (this.#resync) return;
    if (this.#hiddenNative()) {
      this.#deferHandover(audio);
      return;
    }
    this.#handoverTimer = setTimeout(() => {
      this.#handoverTimer = null;
      if (this.#resync) return;
      if (this.#hiddenNative()) {
        this.#deferHandover(audio);
        return;
      }
      audio.pause();
    }, HANDOVER_GRACE_MS);
  }

  // Park the watchdog on a visibility listener (no timer) until the page is
  // on screen again.
  #deferHandover(audio: NarrationClock): void {
    this.#handoverDeferred = onNarrationVisibility((hidden) => {
      if (!hidden) this.#armHandover(audio);
    });
  }

  #cancelHandover(): void {
    this.#handoverDeferred?.();
    this.#handoverDeferred = null;
    if (this.#handoverTimer === null) return;
    clearTimeout(this.#handoverTimer);
    this.#handoverTimer = null;
  }

  #releaseAudio(): void {
    this.#cancelHandover();
    this.#audio?.pause();
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#audio = null;
    this.#audioHref = null;
    this.#objectUrl = null;
    if (this.#native && this.#player) {
      void this.#player.release();
    }
  }

  // Drop the cached clock without tearing the client down. Needed when another
  // TTS engine takes the shared iOS playout AVPlayer (Edge abort): otherwise
  // speak() reuses a dead session and plays silence after switching back.
  invalidatePlayback(): void {
    this.#cancelHandover();
    this.#setResync(null);
    this.#queuedPar = null;
    // #cancelHandover just killed the timer that would have silenced a rolling
    // element, and the reference is dropped below — silence it here or the
    // recording plays on under the engine that took over.
    this.#audio?.pause();
    this.#currentPar = null;
    this.#audioLoad = null;
    this.#audio = null;
    this.#audioHref = null;
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
    if (this.#native && this.#player) {
      this.#player.invalidateSession();
    }
  }

  // Resolve the marks the controller is asking for back to narration units.
  // Marks with no par (dropped as unhighlightable, or filtered out of the SSML)
  // are skipped rather than stalling playback.
  #parsFor(ssml: string): NarrationPar[] {
    const section = this.#section;
    if (!section) return [];
    const { marks } = parseSSMLMarks(ssml, this.#lang);
    const pars: NarrationPar[] = [];
    for (const mark of marks) {
      const par = section.parByMark(mark.name);
      if (par && par !== pars.at(-1)) pars.push(par);
    }
    return pars;
  }

  // TTSController dispatches each utterance's first mark itself, BEFORE it
  // calls speak(), and that dispatch highlights and asks the view to follow.
  // Two cases need it kept off the page:
  //
  // A resync walks the controller forward to where the recording is, and the
  // mark each step dispatches is a sentence the recording already left behind
  // (on a chapter change, the new section's first block). Let through, it
  // highlights and turns the page to that sentence, and then the client's
  // dispatch of the par really sounding moves it again: two repaints on e-ink,
  // and a flash of the wrong line. Those marks are dropped outright: they are
  // stale by definition, and the client's own dispatch lands once it has read
  // the playhead.
  //
  // A block started while the native page is hidden (a headset skip, or the
  // controller's next paragraph arriving after the lock) would highlight and
  // page-follow with the screen off, before the client could check anything.
  // Those marks still reach 'tts-speak-mark' listeners, so the lock-screen
  // metadata and skip handling stay live, but draw nothing. The latest is kept:
  // if the session is paused when the page comes back (a skip made while
  // paused, so no speak() will resync), it is replayed once so the page shows
  // it.
  //
  // Mark-less calls (the controller's reset) always go through, and another
  // engine's marks are never touched.
  #setResync(resync: Resync | null): void {
    this.#resync = resync;
    if (resync) this.#installMarkGate();
    else if (!this.#native) this.#removeMarkGate();
  }

  #markGate(): 'pass' | 'drop' | 'quiet' {
    if (this.#resync) return 'drop';
    if (!this.#hiddenNative()) return 'pass';
    const active = (this.controller as { ttsClient?: unknown } | undefined)?.ttsClient;
    return active === undefined || active === this ? 'quiet' : 'pass';
  }

  #installMarkGate(): void {
    const controller = this.controller;
    if (this.#releaseMarks || typeof controller?.dispatchSpeakMark !== 'function') return;
    const hadOwn = Object.prototype.hasOwnProperty.call(controller, 'dispatchSpeakMark');
    const original = controller.dispatchSpeakMark;
    const decide = (mark: TTSMark): 'pass' | 'drop' | 'quiet' => {
      const gate = this.#markGate();
      this.#heldMark = gate === 'quiet' ? mark : gate === 'pass' ? null : this.#heldMark;
      return gate;
    };
    const gated: TTSController['dispatchSpeakMark'] = function (this: TTSController, mark) {
      if (!mark) return original.call(this, mark);
      const gate = decide(mark);
      if (gate === 'pass') return original.call(this, mark);
      if (gate === 'quiet') {
        this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: mark }));
      }
      return null;
    };
    controller.dispatchSpeakMark = gated;
    if (this.#native) {
      this.#gateVisibility = onNarrationVisibility((hidden) => {
        if (hidden) return;
        const held = this.#heldMark;
        this.#heldMark = null;
        // While playing, the speak() running (or about to run) this block
        // lands its own dispatch on the par under the playhead, and a pending
        // resync lands the client's. Replay only for a paused session.
        const playing = (controller as { state?: string }).state === 'playing';
        if (!held || playing || this.#coasting || this.#resync) return;
        original.call(controller, held);
      });
    }
    this.#releaseMarks = () => {
      this.#gateVisibility?.();
      this.#gateVisibility = null;
      this.#heldMark = null;
      if (controller.dispatchSpeakMark !== gated) return;
      if (hadOwn) controller.dispatchSpeakMark = original;
      else Reflect.deleteProperty(controller, 'dispatchSpeakMark');
    };
  }

  #removeMarkGate(): void {
    this.#releaseMarks?.();
    this.#releaseMarks = null;
  }

  #hiddenNative(): boolean {
    return this.#native && isNarrationHidden();
  }

  // Whether a section change the controller makes now must leave the page
  // alone. With the native page hidden (a headset skip, or the controller
  // moving on while locked) there is nothing to draw on and an e-ink panel
  // must not repaint. During a resync the sections the controller walks
  // through are behind the recording, and turning to one first would be a
  // second navigation before the one to the sentence sounding. Either way the
  // first mark that lands afterwards navigates straight to its sentence.
  holdsPageMoves(): boolean {
    return this.#resync !== null || this.#hiddenNative();
  }

  // Resolve once the clock reaches `until`, or once playback ends, fails, or is
  // aborted, or (native only) the page goes hidden. Listeners are registered
  // synchronously so no tick can be missed.
  #waitUntil(audio: NarrationClock, until: number, signal: AbortSignal): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (outcome: WaitOutcome) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        audio.removeEventListener('timeupdate', check);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        unsubscribe?.();
        resolve(outcome);
      };
      const check = () => {
        if (signal.aborted) return finish('aborted');
        // Covers a hide that landed while no listener was attached (the
        // generator suspended at its boundary yield).
        if (this.#native && isNarrationHidden()) return finish('hidden');
        if (audio.currentTime >= until) finish('reached');
      };
      const onEnded = () => finish('ended');
      const onError = () => finish('error');
      const onAbort = () => finish('aborted');

      const timer = setInterval(check, CLOCK_POLL_MS);
      audio.addEventListener('timeupdate', check);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort);
      if (this.#native) {
        unsubscribe = onNarrationVisibility((hidden) => {
          if (hidden) finish('hidden');
        });
      }
      check();
    });
  }

  // Hidden-page wait: resolves only on a native event or a return to visible,
  // never on a timer.
  #waitForCoastEvent(
    audio: NarrationClock,
    signal: AbortSignal,
  ): Promise<'ended' | 'error' | 'aborted' | 'visible'> {
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (outcome: 'ended' | 'error' | 'aborted' | 'visible') => {
        if (done) return;
        done = true;
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        unsubscribe?.();
        resolve(outcome);
      };
      const onEnded = () => finish('ended');
      const onError = () => finish('error');
      const onAbort = () => finish('aborted');
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort);
      unsubscribe = onNarrationVisibility((hidden) => {
        if (!hidden) finish('visible');
      });
      if (signal.aborted) finish('aborted');
      else if (!isNarrationHidden()) finish('visible');
    });
  }

  // The first clip after `href` in a different file: later in the same
  // section, else at the start of the next narrated section, whose SMIL is
  // read straight from the book (no document needed for timing alone).
  async #nextClip(
    href: string | null,
    place: CoastPlace,
  ): Promise<{ clip: Clip; clips: Clip[]; sectionIndex: number } | null> {
    if (!href) return null;
    let lastIndex = -1;
    place.clips.forEach((clip, index) => {
      if (clip.audioHref === href) lastIndex = index;
    });
    const inSection = place.clips.slice(lastIndex + 1).find((clip) => clip.audioHref !== href);
    if (inSection) return { clip: inSection, clips: place.clips, sectionIndex: place.sectionIndex };

    // "Stop at end of chapter" (sleep timer) ends playback at the section
    // boundary; hidden playback must not carry on past it.
    if (this.controller?.stopAtChapterEnd) return null;
    const book = this.#book;
    const sections = book?.sections;
    if (!book?.loadText || !sections || place.sectionIndex < 0) return null;
    for (let index = place.sectionIndex + 1; index < sections.length; index++) {
      const overlayHref = sections[index]?.mediaOverlay?.href;
      if (!overlayHref) continue;
      let xml: string | null = null;
      try {
        xml = await book.loadText(overlayHref);
      } catch {
        continue;
      }
      if (!xml) continue;
      const clips = parseSmil(xml, overlayHref);
      const clip = clips.find((c) => c.audioHref !== href);
      if (clip) return { clip, clips, sectionIndex: index };
    }
    return null;
  }

  // Follow the recording while the page is hidden. The native player runs on
  // by itself through contiguous clips; the only work here is loading the next
  // file when one ends. Returns on a return to visible, the end of the
  // recording, an abort, or a failure.
  async #coast(
    signal: AbortSignal,
    place: CoastPlace,
    alreadyEnded: boolean,
  ): Promise<CoastOutcome> {
    this.#coasting = true;
    try {
      let ended = alreadyEnded;
      for (;;) {
        if (signal.aborted) return 'aborted';
        if (!ended) {
          const audio = this.#audio;
          if (!audio) return 'finished';
          const outcome = await this.#waitForCoastEvent(audio, signal);
          if (outcome !== 'ended') return outcome;
        }
        ended = false;
        const next = await this.#nextClip(this.#audioHref, place);
        if (signal.aborted) return 'aborted';
        if (!next) return 'finished';
        if (next.sectionIndex !== place.sectionIndex) {
          place.clips = next.clips;
          place.sectionIndex = next.sectionIndex;
          place.crossed = true;
        }
        let audio: NarrationClock;
        try {
          audio = await this.#ensureAudio(next.clip.audioHref, true);
        } catch {
          return 'error';
        }
        if (signal.aborted) return 'aborted';
        if (this.#native && this.#player) await this.#player.seek(next.clip.clipBegin);
        else audio.currentTime = next.clip.clipBegin;
        try {
          await audio.play();
        } catch {
          return 'error';
        }
      }
    } finally {
      this.#coasting = false;
    }
  }

  // The par under the native playhead, read fresh from the player.
  async #locate(fileEnded: boolean): Promise<Located> {
    const section = this.#section;
    const href = this.#audioHref;
    const audio = this.#audio;
    if (!section || !href || !audio) return { kind: 'unknown' };
    const seconds = fileEnded
      ? Number.POSITIVE_INFINITY
      : this.#native && this.#player
        ? await this.#player.refreshPosition()
        : audio.currentTime;
    if (this.#section !== section || this.#audioHref !== href) return { kind: 'unknown' };
    return locateInSection(section.pars, href, seconds, fileEnded);
  }

  #textSource(): NarrationTextSource | null {
    const tts = (this.controller?.view as { tts?: unknown } | undefined)?.tts;
    if (!tts || typeof tts !== 'object') return null;
    const candidate = tts as Partial<NarrationTextSource>;
    if (candidate.section !== this.#section || typeof candidate.from !== 'function') return null;
    return candidate as NarrationTextSource;
  }

  // Move the controller's cursor to `par` without drawing: from() positions it
  // silently, so the controller's next step starts from the audible sentence.
  #parkCursor(par: NarrationPar | undefined): void {
    if (!par) return;
    try {
      this.#textSource()?.from(par.range);
    } catch {
      // A detached view has no cursor to move; the controller keeps its own.
    }
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    let pars = this.#parsFor(ssml);

    if (preload) {
      // The only fetchable work is the audio file itself; warming it keeps the
      // first play of a section from stalling on a large clip read out of the
      // container. Only when nothing is loaded yet: preloading runs CONCURRENTLY
      // with playback, and loading a different file swaps the element (and
      // revokes its blob URL) out from under the clip being played.
      const href = pars[0]?.audioHref;
      if (href && !this.#audio) await this.#ensureAudio(href).catch(() => undefined);
      return;
    }

    if (!pars.length) {
      yield { code: 'end', message: 'No narration for this block' };
      return;
    }

    let requestedStart = this.#nextChunkPosition;
    this.#nextChunkPosition = null;
    let inPlace = false;

    // The recording ran on past the controller's section while the screen was
    // off. This utterance is the controller catching up: park it at the end of
    // this section to move on, or pick up at the par now sounding.
    if (this.#resync) {
      const resync = this.#resync;
      const located = await this.#locate(false);
      if (signal.aborted) return;
      const target = resync.target;
      const behind = target
        ? !this.#section?.pars.some((par) => target.has(clipKey(par)))
        : located.kind === 'ahead';
      if (behind && resync.steps < MAX_RESYNC_STEPS) {
        resync.steps += 1;
        this.#parkCursor(this.#section?.pars.at(-1));
        yield { code: 'end', message: 'Narration continues in a later section' };
        return;
      }
      this.#setResync(null);
      if (located.kind !== 'unknown' && this.#section) {
        pars = this.#section.parsFrom(located.par.markName);
        requestedStart = null;
        inPlace = true;
      }
    }

    for (;;) {
      const result = yield* this.#playPars(pars, signal, requestedStart, inPlace);
      requestedStart = null;
      if (result.kind === 'stop') return;
      if (result.kind === 'done') break;

      // Screen off. Follow the recording from native events alone, and come
      // back here only once the page is visible (and still visible after the
      // position read, so rapid toggles resync once) or the audio ran out.
      const place: CoastPlace = {
        clips: this.#section?.pars ?? [],
        sectionIndex: this.#sectionIndex,
        crossed: false,
      };
      let ended = result.ended;
      let outcome: CoastOutcome;
      let located: Located = { kind: 'unknown' };
      for (;;) {
        outcome = await this.#coast(signal, place, ended);
        ended = false;
        if (outcome === 'aborted' || outcome === 'error') break;
        located = await this.#locate(outcome === 'finished');
        if (signal.aborted) {
          outcome = 'aborted';
          break;
        }
        if (outcome === 'visible' && this.#hiddenNative()) continue;
        break;
      }

      if (outcome === 'aborted') {
        this.#audio?.pause();
        return;
      }
      if (outcome === 'error') {
        yield { code: 'error', message: 'Narration playback failed' };
        return;
      }
      if (located.kind === 'ahead') {
        this.#setResync({
          target: place.crossed ? new Set(place.clips.map(clipKey)) : null,
          steps: 0,
        });
        this.#parkCursor(located.par);
        if (outcome === 'finished') this.#audio?.pause();
        yield { code: 'end', message: 'Narration continues in a later section' };
        return;
      }
      if (outcome === 'finished') {
        // The recording ran out with nothing to queue behind it. Leave the
        // controller at the last sentence heard and let it decide what follows.
        this.#parkCursor(located.kind === 'here' ? located.par : undefined);
        this.#audio?.pause();
        yield { code: 'end', message: 'Narration finished' };
        return;
      }

      // Visible again: carry on from the par now sounding. #playPars lands the
      // one navigation and highlight on it.
      const target = located.kind === 'here' ? located.par : (this.#queuedPar ?? pars[0]!);
      this.#queuedPar = null;
      if (this.#section) pars = this.#section.parsFrom(target.markName);
      if (!pars.length) break;
      inPlace = located.kind === 'here';
    }

    // The block's clips are done, but the recording continues into the next
    // paragraph, so the element keeps playing and the next block joins it in
    // progress. Pausing here — and again in the controller's pre-speak stop —
    // was putting a gap at every paragraph boundary, which on Android also costs
    // a buffer flush. The watchdog covers the case where no next block comes.
    if (this.#audio) this.#armHandover(this.#audio);
    yield { code: 'end', message: 'Narration finished' };
  }

  // Play `pars` (the rest of one block) off the shared clock, reporting each
  // par as it becomes audible. Returns 'hidden' as soon as the native page goes
  // hidden, before anything is drawn for the next par. `inPlace` resumes after
  // a resync: the playhead is already inside the first par and the transport is
  // however the listener left it, so neither is touched.
  async *#playPars(
    pars: NarrationPar[],
    signal: AbortSignal,
    requestedStart: number | null,
    inPlace: boolean,
  ): AsyncGenerator<TTSMessageEvent, PlayResult> {
    const runs = toRuns(pars);
    for (const [runIndex, run] of runs.entries()) {
      if (signal.aborted) return STOP;

      let audio: NarrationClock;
      try {
        audio = await this.#ensureAudio(run.audioHref);
      } catch (e) {
        yield { code: 'error', message: e instanceof Error ? e.message : 'Narration unavailable' };
        return STOP;
      }
      if (signal.aborted) return STOP;

      this.#cancelHandover();
      if (this.#native && this.#player) await this.#player.setRate(this.#rate);
      else audio.playbackRate = this.#rate;
      if (!(inPlace && runIndex === 0)) {
        // Sequential narration needs no seeking: Media Overlay clips are
        // contiguous and in document order, so the element can simply keep
        // rolling while boundaries are reported as the clock passes each clip.
        // Seeking to clipBegin on every paragraph replayed the milliseconds that
        // clip-end detection had already overshot into the next clip — heard as
        // a stutter on the paragraph's first word ("me me"). Move the playhead
        // only for a real discontinuity: session start, a sentence skip, a
        // scrub, a new audio file.
        const first = run.pars[0]!;
        const requestedPosition =
          runIndex === 0 && requestedStart !== null
            ? first.clipBegin +
              Math.min(Math.max(requestedStart, 0), first.clipEnd - first.clipBegin)
            : null;
        const alreadyRolling =
          audio.currentTime >= first.clipBegin - CLIP_CONTINUITY_TOLERANCE_SEC &&
          audio.currentTime < first.clipEnd;
        if (requestedPosition !== null || !alreadyRolling) {
          const position = requestedPosition ?? first.clipBegin;
          // Native seek is async (plugin invoke); assigning currentTime alone
          // can race with play() and start from the previous playhead.
          if (this.#native && this.#player) await this.#player.seek(position);
          else audio.currentTime = position;
        }
        try {
          await audio.play();
        } catch (e) {
          // An autoplay rejection is terminal for this attempt; the session's
          // gesture-time unblockAudio() is what normally prevents it.
          yield { code: 'error', message: e instanceof Error ? e.message : 'Playback blocked' };
          return STOP;
        }
      }

      for (const par of run.pars) {
        if (signal.aborted) {
          audio.pause();
          return STOP;
        }
        // Hidden: nothing to draw on, and an e-ink panel must not be asked to
        // repaint. Remember the par and hand over to the coast.
        if (this.#hiddenNative()) {
          this.#queuedPar = par;
          return { kind: 'hidden', ended: false };
        }
        this.#currentPar = par;
        this.controller?.dispatchSpeakMark({
          offset: 0,
          name: par.markName,
          text: par.text,
          language: this.#lang,
        });
        yield { code: 'boundary', mark: par.markName, message: 'narration' };

        const outcome = await this.#waitUntil(audio, par.clipEnd, signal);
        if (outcome === 'aborted') {
          audio.pause();
          return STOP;
        }
        if (outcome === 'error') {
          yield { code: 'error', message: 'Narration playback failed' };
          return STOP;
        }
        if (outcome === 'hidden') {
          this.#queuedPar = par;
          return { kind: 'hidden', ended: false };
        }
        // The file ran out: nothing left of this block to play.
        if (outcome === 'ended') {
          if (this.#hiddenNative()) {
            this.#queuedPar = par;
            return { kind: 'hidden', ended: true };
          }
          audio.pause();
          yield { code: 'end', message: 'Narration finished' };
          return STOP;
        }
      }
    }
    return DONE;
  }

  async pause(): Promise<boolean> {
    // A pause ends any catch-up walk: what follows is the listener's choice.
    this.#setResync(null);
    this.#cancelHandover();
    this.#audio?.pause();
    return true;
  }

  async resume(): Promise<boolean> {
    await this.#audio?.play().catch(() => undefined);
    return true;
  }

  async stop(handover = false): Promise<void> {
    // A transport command while the screen is off (a headset skip). The
    // controller's cursor is still where the screen went off; move it, without
    // drawing, to the sentence now sounding before the controller steps from it.
    if (this.#coasting) this.#syncCursorToAudio();
    this.#currentPar = null;
    // The element and its blob URL are kept: every paragraph advance calls
    // stop(), and re-fetching the chapter's audio each time would be absurd.
    if (handover && this.#audio && !this.#audio.paused) {
      // Handing over to the next utterance of the same recording: silencing the
      // element here is what the listener hears as a gap between paragraphs.
      this.#armHandover(this.#audio);
      return;
    }
    // A real stop (not a handover to the next block) ends any catch-up walk.
    if (!handover) this.#setResync(null);
    this.#cancelHandover();
    this.#audio?.pause();
  }

  #syncCursorToAudio(): void {
    const section = this.#section;
    const href = this.#audioHref;
    const audio = this.#audio;
    if (!section || !href || !audio) return;
    const located = locateInSection(section.pars, href, audio.currentTime, false);
    if (located.kind !== 'unknown') this.#parkCursor(located.par);
  }

  setPrimaryLang(lang: string): void {
    this.#lang = lang || 'en';
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
    // Await the native set-rate invoke: assigning playbackRate alone was
    // fire-and-forget, so stop→setRate→start (and live changes) raced play()
    // and left AVPlayer at the previous rate until the next voice switch.
    if (this.#native && this.#player) {
      await this.#player.setRate(rate);
    } else if (this.#audio) {
      this.#audio.playbackRate = rate;
    }
  }

  async setPitch(_pitch: number): Promise<void> {
    // A recording has the narrator's pitch; nothing to set.
  }

  async setVoice(_voice: string): Promise<void> {
    // The narration is the voice.
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices();
  }

  async getVoices(_lang: string): Promise<TTSVoicesGroup[]> {
    return [
      {
        id: 'media-overlay',
        name: _('Narration'),
        voices: this.#voices(),
      },
    ];
  }

  #voices(): TTSVoice[] {
    if (!this.#source) return [];
    return [{ id: MEDIA_OVERLAY_VOICE_ID, name: this.#narratorName(), lang: this.#lang }];
  }

  getGranularities(): TTSGranularity[] {
    // The recording's own sync granularity decides the unit; nothing to choose.
    return ['sentence'];
  }

  getCapabilities(): TTSCapabilities {
    return {
      // Media Overlays time whole elements. When the publisher marked words,
      // those elements ARE words and the sentence highlight is a word
      // highlight; interpolating within a clip would only invent drift.
      wordBoundaries: false,
      mediaClock: true,
      gapControl: false,
      liveRateChange: true,
      continuousTimeline: true,
      textHighlight: this.#source?.textHighlight !== false,
    };
  }

  setNextChunkPosition(seconds: number): void {
    this.#nextChunkPosition = Number.isFinite(seconds) ? Math.max(seconds, 0) : null;
  }

  getChunkPosition(): number | null {
    if (!this.#audio || !this.#currentPar) return null;
    const { clipBegin, clipEnd } = this.#currentPar;
    const position = this.#audio.currentTime - clipBegin;
    return Math.min(Math.max(position, 0), clipEnd - clipBegin);
  }

  // Null while the native page is hidden. The view's sentence page-follow
  // polls this and turns the page when the audio passes the page break; with
  // the screen off it must not, and a null here is what stops that follow
  // (useTTSControl drops its interval on null). The resync on unlock re-arms
  // it from the par then sounding.
  getChunkProgress(): number | null {
    if (this.#hiddenNative()) return null;
    if (!this.#audio || !this.#currentPar) return null;
    const { clipBegin, clipEnd } = this.#currentPar;
    const duration = clipEnd - clipBegin;
    if (duration <= 0) return null;
    const elapsed = this.#audio.currentTime - clipBegin;
    return Math.min(Math.max(elapsed / duration, 0), 1);
  }

  async seekToChunkPosition(seconds: number): Promise<boolean> {
    const audio = this.#audio;
    const par = this.#currentPar;
    if (!audio || !par) return false;
    const within = Math.min(Math.max(seconds, 0), par.clipEnd - par.clipBegin);
    const position = par.clipBegin + within;
    if (this.#native && this.#player) await this.#player.seek(position);
    else audio.currentTime = position;
    return true;
  }

  getVoiceId(): string {
    return MEDIA_OVERLAY_VOICE_ID;
  }

  getSpeakingLang(): string {
    return this.#lang;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    const player = this.#player;
    this.#player = null;
    this.#releaseAudio();
    if (player) await player.shutdown();
    this.#currentPar = null;
    this.#queuedPar = null;
    this.#setResync(null);
    this.#removeMarkGate();
    this.#section = null;
    this.#source = null;
  }
}
