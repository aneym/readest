/** Bounded takes keep PCM memory and uploads well below the server's 32 MiB limit. */
export const MAX_RECORDING_SECONDS = 120;
const WAV_RATE = 16_000;

/** Pure PCM conversion: average channels, resample, clamp and write little-endian WAV. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('Invalid PCM');
  const length = channels[0]!.length;
  if (channels.some((channel) => channel.length !== length)) throw new Error('Unequal channels');
  const count = Math.floor((length * WAV_RATE) / sampleRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const label = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  label(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, WAV_RATE, true);
  view.setUint32(28, WAV_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, count * 2, true);
  const mono = (index: number) =>
    channels.reduce((sum, channel) => sum + (channel[index] ?? 0), 0) / channels.length;
  for (let i = 0; i < count; i++) {
    // Area averaging avoids aliasing when downsampling; interpolate when upsampling.
    const start = (i * sampleRate) / WAV_RATE;
    const end = ((i + 1) * sampleRate) / WAV_RATE;
    let sample = 0;
    if (sampleRate >= WAV_RATE) {
      for (let j = Math.floor(start); j < Math.ceil(end); j++)
        sample += mono(j) * (Math.min(end, j + 1) - Math.max(start, j));
      sample /= end - start;
    } else {
      const index = Math.floor(start);
      sample =
        mono(index) + (mono(Math.min(index + 1, length - 1)) - mono(index)) * (start - index);
    }
    sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export interface WavRecording {
  stop(): Promise<Blob>;
  cancel(): void;
}

/** No MediaRecorder/container dependency. AudioWorklet first, legacy WebView fallback. */
export async function startWavRecording(): Promise<WavRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let context: AudioContext | undefined;
  let processor: AudioWorkletNode | ScriptProcessorNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const chunks: Float32Array[] = [];
  let samples = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    source?.disconnect();
    processor?.disconnect();
    if (typeof AudioWorkletNode !== 'undefined' && processor instanceof AudioWorkletNode)
      processor.port.close();
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
  try {
    context = new AudioContext();
    const rate = context.sampleRate;
    const collect = (chunk: Float32Array) => {
      if (closed) return;
      const available = Math.floor(rate * MAX_RECORDING_SECONDS) - samples;
      if (available <= 0) return;
      const bounded = chunk.slice(0, available);
      chunks.push(bounded);
      samples += bounded.length;
    };
    source = context.createMediaStreamSource(stream);
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const url = URL.createObjectURL(
        new Blob(
          [
            `
        class MonoCapture extends AudioWorkletProcessor {
          process(inputs) {
            const channels = inputs[0];
            if (channels && channels.length) {
              const mono = new Float32Array(channels[0].length);
              for (const channel of channels)
                for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
              this.port.postMessage(mono, [mono.buffer]);
            }
            return true;
          }
        }
        registerProcessor('thoughts-mono-capture', MonoCapture);
      `,
          ],
          { type: 'text/javascript' },
        ),
      );
      try {
        await context.audioWorklet.addModule(url);
        processor = new AudioWorkletNode(context, 'thoughts-mono-capture');
        processor.port.onmessage = (event: MessageEvent<Float32Array>) => collect(event.data);
      } catch {
        // Some Android WebViews expose AudioWorklet but cannot load a blob module.
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!processor) {
      processor = context.createScriptProcessor(4096, source.channelCount, 1);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const mono = new Float32Array(input.length);
        for (let channel = 0; channel < input.numberOfChannels; channel++) {
          const data = input.getChannelData(channel);
          for (let i = 0; i < mono.length; i++)
            mono[i] = mono[i]! + data[i]! / input.numberOfChannels;
        }
        collect(mono);
      };
    }
    source.connect(processor);
    // Processors output silence, not the microphone, to keep the graph running.
    processor.connect(context.destination);
    await context.resume();
    timer = setTimeout(cleanup, MAX_RECORDING_SECONDS * 1000);
    return {
      async stop() {
        cleanup();
        const pcm = new Float32Array(samples);
        let offset = 0;
        for (const chunk of chunks) {
          pcm.set(chunk, offset);
          offset += chunk.length;
        }
        return new Blob([encodeWav([pcm], rate)], { type: 'audio/wav' });
      },
      cancel() {
        cleanup();
        chunks.length = 0;
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
