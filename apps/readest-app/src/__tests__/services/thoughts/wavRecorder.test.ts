import { expect, test } from 'vitest';
import { encodeWav } from '@/services/thoughts/wavRecorder';

// Pure PCM algorithm: table covers clipping, stereo cancellation and rate conversion.
test.each([
  {
    channels: [[-2, -1, 0, 0.5, 1, 2]],
    rate: 16000,
    pcm: [-32768, -32768, 0, 16384, 32767, 32767],
  },
  {
    channels: [
      [1, -1],
      [-1, 1],
    ],
    rate: 16000,
    pcm: [0, 0],
  },
  { channels: [[1, 0, -1, 0]], rate: 32000, pcm: [16384, -16384] },
  { channels: [[0, 1]], rate: 8000, pcm: [0, 16384, 32767, 32767] },
  { channels: [[NaN, Infinity]], rate: 16000, pcm: [0, 0] },
])('writes interoperable mono WAV at $rate Hz input', ({ channels, rate, pcm }) => {
  const buffer = encodeWav(
    channels.map((channel) => new Float32Array(channel)),
    rate,
  );
  const view = new DataView(buffer);
  const label = (start: number, end: number) =>
    String.fromCharCode(...new Uint8Array(buffer).slice(start, end));
  expect(label(0, 4)).toBe('RIFF');
  expect(label(8, 16)).toBe('WAVEfmt ');
  expect(label(36, 40)).toBe('data');
  expect(buffer.byteLength).toBe(44 + pcm.length * 2);
  expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
  expect(view.getUint32(16, true)).toBe(16);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(28, true)).toBe(32000);
  expect(view.getUint16(32, true)).toBe(2);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  expect(pcm.map((_, index) => view.getInt16(44 + index * 2, true))).toEqual(pcm);
});
test('rejects invalid PCM shape and rates', () => {
  expect(() => encodeWav([], 16000)).toThrow();
  expect(() => encodeWav([new Float32Array(1)], 0)).toThrow();
  expect(() => encodeWav([new Float32Array(1), new Float32Array(2)], 16000)).toThrow();
});
