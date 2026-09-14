import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCallRecorder, SYSTEM_AUDIO_ERROR } from '../src/recorder';

class Track extends EventTarget {
  readyState = 'live';
  stopped = false;
  constructor(public kind: 'audio' | 'video') { super(); }
  stop() { this.readyState = 'ended'; this.stopped = true; }
  disconnectSource() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
  gain = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  fftSize = 256;
  getFloatTimeDomainData(values: Float32Array) { values.fill(0.2); }
}
let contexts: FakeAudioContext[];
class FakeAudioContext {
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = new Node();
  sourceStreams: Stream[] = [];
  constructor() { contexts.push(this); }
  createMediaStreamDestination() { return Object.assign(new Node(), { stream: new Stream([new Track('audio')]) }); }
  createDynamicsCompressor() { return new Node(); }
  createGain() { return new Node(); }
  createAnalyser() { return new Node(); }
  createMediaStreamSource(stream: Stream) { this.sourceStreams.push(stream); return new Node(); }
}
let encoders: Encoder[];
class Encoder {
  static isTypeSupported(type: string) { return type.includes('webm'); }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: Stream) { encoders.push(this); }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['recorded audio'], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}
let display: Stream;
let microphone: Stream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  contexts = [];
  encoders = [];
  display = new Stream([new Track('audio'), new Track('video')]);
  microphone = new Stream([new Track('audio')]);
  getDisplayMedia = vi.fn(async () => display);
  getUserMedia = vi.fn(async () => microphone);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia, getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('MediaRecorder', Encoder);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('call recorder source integrity', () => {
  it('mixes both audio inputs and saves no display video', async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    expect(contexts[0].sourceStreams).toHaveLength(2);
    expect(contexts[0].sourceStreams.every(stream => stream.getVideoTracks().length === 0)).toBe(true);
    expect(encoders[0].stream.getAudioTracks()).toHaveLength(1);
    expect(encoders[0].stream.getVideoTracks()).toHaveLength(0);
    const result = await recorder.stop();
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toBe('audio/webm;codecs=opus');
    expect(display.getTracks().every(track => track.stopped)).toBe(true);
    expect(microphone.getTracks().every(track => track.stopped)).toBe(true);
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('rejects missing system audio without silently recording only the mic', async () => {
    display = new Stream([new Track('video')]);
    const recorder = createCallRecorder();
    await expect(recorder.start()).rejects.toThrow(SYSTEM_AUDIO_ERROR);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(display.getTracks()[0].stopped).toBe(true);
    expect(recorder.state).toBe('idle');
  });

  it('rejects an ended macOS system track even if an audio track exists', async () => {
    display.getAudioTracks()[0].stop();
    await expect(createCallRecorder().start()).rejects.toThrow(SYSTEM_AUDIO_ERROR);
    expect(display.getVideoTracks()[0].stopped).toBe(true);
  });

  it('releases acquired screen and system audio when microphone permission fails', async () => {
    getUserMedia.mockRejectedValue(new Error('Microphone permission denied'));
    await expect(createCallRecorder().start()).rejects.toThrow('Microphone permission denied');
    expect(display.getTracks().every(track => track.stopped)).toBe(true);
    expect(encoders).toHaveLength(0);
  });

  it('stops a late permission stream after the UI was disposed', async () => {
    let resolve!: (stream: Stream) => void;
    getDisplayMedia.mockImplementation(() => new Promise<Stream>(done => { resolve = done; }));
    const recorder = createCallRecorder();
    const pending = recorder.start();
    recorder.dispose();
    resolve(display);
    await expect(pending).rejects.toThrow('cancelled');
    expect(display.getTracks().every(track => track.stopped)).toBe(true);
    expect(contexts).toHaveLength(0);
  });

  it('pauses and reports source disconnection while keeping recorded bytes saveable', async () => {
    const onError = vi.fn();
    const recorder = createCallRecorder({ onError });
    await recorder.start();
    display.getAudioTracks()[0].disconnectSource();
    expect(recorder.state).toBe('paused');
    expect(onError).toHaveBeenCalledOnce();
    expect(() => recorder.resume()).toThrow('disconnected');
    expect((await recorder.stop()).blob.size).toBeGreaterThan(0);
  });

  it('excludes paused time from the saved duration and supports a second recording', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const recorder = createCallRecorder();
    await recorder.start({ includeSystem: false });
    now = 1000;
    recorder.pause();
    now = 9000;
    recorder.resume();
    now = 9500;
    expect((await recorder.stop()).durationMs).toBe(1500);
    microphone = new Stream([new Track('audio')]);
    await recorder.start({ includeSystem: false });
    expect(recorder.state).toBe('recording');
    await recorder.stop();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('rejects overlapping starts and empty source selection', async () => {
    const recorder = createCallRecorder();
    await expect(recorder.start({ includeSystem: false, includeMic: false })).rejects.toThrow('Choose');
    await recorder.start({ includeSystem: false });
    await expect(recorder.start()).rejects.toThrow('already active');
    recorder.dispose();
    expect(microphone.getTracks().every(track => track.stopped)).toBe(true);
  });
});
