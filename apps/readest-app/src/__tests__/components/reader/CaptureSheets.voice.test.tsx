import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaptureSheets } from '@/app/reader/components/capture/CaptureSheets';
import { eventDispatcher } from '@/utils/event';

vi.mock('@/services/household', () => ({ isHouseholdBuild: () => true }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));

// Integration: real sheets, PCM recorder and thoughts client; fake only browser audio/network edges.
const stopTrack = vi.fn();
const microphone = vi.fn();
const network = vi.fn();
let audioCallback:
  | ((event: {
      inputBuffer: { length: number; numberOfChannels: number; getChannelData(): Float32Array };
    }) => void)
  | null;
class BrowserAudioContext {
  sampleRate = 48000;
  destination = {};
  createMediaStreamSource() {
    return { channelCount: 1, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    return {
      set onaudioprocess(callback: typeof audioCallback) {
        audioCallback = callback;
      },
      connect() {},
      disconnect() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-device-token');
  audioCallback = null;
  stopTrack.mockReset();
  microphone.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  network.mockReset().mockResolvedValue(
    new Response(
      JSON.stringify({
        thought: { captureId: 'voice-id', body: 'Remember this idea' },
      }),
    ),
  );
  vi.stubGlobal('AudioContext', BrowserAudioContext);
  vi.stubGlobal('fetch', network);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: microphone },
  });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open(kind: string) {
  render(<CaptureSheets />);
  await act(async () => {
    await eventDispatcher.dispatch('reader-capture-open', { bookKey: 'voice-book', kind });
  });
}
async function hold() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await screen.findByText('Recording…');
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800).fill(0.25),
    },
  });
}
test('hold records static status; release posts WAV with device auth and closes Voice', async () => {
  await open('voice');
  await hold();
  expect(network).not.toHaveBeenCalled();
  fireEvent.keyUp(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(stopTrack).toHaveBeenCalledOnce();
  const [url, request] = network.mock.calls[0]!;
  expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts/voice');
  expect(request.method).toBe('POST');
  expect(request.headers).toMatchObject({
    'Content-Type': 'audio/wav',
    Authorization: 'Bearer test-device-token',
    'X-Intent-Id': expect.any(String),
  });
  expect(request.body.type).toBe('audio/wav');
  expect(request.body.size).toBe(3244);
});
test.each([
  'note',
  'page-note',
])('transcript inserts into %s without losing typed draft', async (kind) => {
  await open(kind);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Typed draft' } });
  await hold();
  fireEvent.keyUp(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(
      'Typed draft\nRemember this idea',
    ),
  );
});
test('permission denied displays settings guidance and does not post', async () => {
  microphone.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  await open('voice');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await screen.findByText('Microphone access is off. Allow it in Settings to record.');
  expect(screen.queryByText('Recording…')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
test('offline keeps take for explicit retry and never claims it was queued', async () => {
  await open('voice');
  await hold();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent.keyUp(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await screen.findByText("Couldn't send. Try again when you're back online.");
  expect(network).not.toHaveBeenCalled();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(network).toHaveBeenCalledOnce();
});

test('pointer hold/release sends; cancelled gesture discards audio', async () => {
  await open('voice');
  const button = screen.getByRole('button', { name: 'Hold to talk' });
  fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await screen.findByText('Recording…');
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800),
    },
  });
  fireEvent(button, new MouseEvent('pointercancel', { bubbles: true }));
  await waitFor(() => expect(screen.queryByText('Recording…')).toBeNull());
  expect(network).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalledOnce();
  fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await screen.findByText('Recording…');
  await waitFor(() => expect(microphone).toHaveBeenCalledTimes(2));
  await act(async () => {});
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800),
    },
  });
  fireEvent(button, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(network).toHaveBeenCalledOnce();
});
