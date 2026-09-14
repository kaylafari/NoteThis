/** Browser audio graph used by the desktop app and the browser upload/record flow. */
export type RecorderState = 'idle' | 'recording' | 'paused';
export interface RecorderOptions {
  onLevels?: (levels: { mic: number; system: number }) => void;
  onStateChange?: (state: RecorderState) => void;
  onError?: (error: Error) => void;
}
export interface RecordingSources {
  includeMic?: boolean;
  includeSystem?: boolean;
  microphoneDeviceId?: string;
}
export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  /** Excludes time spent paused. */
  durationMs: number;
}

export const SYSTEM_AUDIO_ERROR = 'No live system-audio track was received. In the desktop app, allow System Audio Recording (and Screen Recording if requested) in macOS System Settings → Privacy & Security, then restart the app. In a browser, choose a tab with Share audio enabled, or use the desktop app to record the whole call.';

export function preferredRecordingMimeType(): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function createCallRecorder(options: RecorderOptions = {}) {
  let state: RecorderState = 'idle';
  let starting = false;
  let generation = 0;
  let context: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let streams: MediaStream[] = [];
  let nodes: AudioNode[] = [];
  let listeners: Array<() => void> = [];
  let chunks: Blob[] = [];
  let meterTimer: ReturnType<typeof setInterval> | undefined;
  let activeStartedAt = 0;
  let activeDuration = 0;
  let stopPromise: Promise<RecordingResult> | null = null;
  let recorderError: Error | null = null;

  function setState(next: RecorderState) {
    state = next;
    options.onStateChange?.(next);
  }

  function cleanResources() {
    clearInterval(meterTimer);
    meterTimer = undefined;
    for (const remove of listeners) remove();
    listeners = [];
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    streams = [];
    for (const node of nodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
    nodes = [];
    if (context) void context.close().catch(() => undefined);
    context = null;
    options.onLevels?.({ mic: 0, system: 0 });
  }

  function pause() {
    if (state !== 'recording' || !recorder) return;
    if (recorder.state === 'recording') recorder.pause();
    activeDuration += performance.now() - activeStartedAt;
    setState('paused');
    options.onLevels?.({ mic: 0, system: 0 });
  }

  function resume() {
    if (state !== 'paused' || !recorder || recorder.state !== 'paused') return;
    const ended = streams.some(stream => stream.getAudioTracks().some(track => track.readyState !== 'live'));
    if (ended) throw new Error('An audio source disconnected. Save this recording and start a new one.');
    recorder.resume();
    activeStartedAt = performance.now();
    setState('recording');
  }

  async function start(sources: RecordingSources = {}) {
    if (starting || state !== 'idle' || stopPromise) throw new Error('A recording is already active.');
    const includeMic = sources.includeMic ?? true;
    const includeSystem = sources.includeSystem ?? true;
    if (!includeMic && !includeSystem) throw new Error('Choose microphone audio, system audio, or both.');
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported here. Open the desktop app or a current browser on localhost.');
    starting = true;
    const run = ++generation;
    chunks = [];
    activeDuration = 0;
    recorderError = null;
    const inputs: Array<{ kind: 'mic' | 'system'; stream: MediaStream }> = [];
    // A pending permission prompt can outlive dispose(). Never retain its late stream.
    function retain(stream: MediaStream, kind: 'mic' | 'system') {
      if (run !== generation) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('Recording was cancelled.');
      }
      streams.push(stream);
      inputs.push({ kind, stream });
      const audio = stream.getAudioTracks();
      if (!audio.length || audio.some(track => track.readyState !== 'live')) {
        throw new Error(kind === 'system' ? SYSTEM_AUDIO_ERROR : 'No live microphone track was received. Check microphone permission and the selected input device.');
      }
    }
    try {
      // Request display first, while the Start button's user activation is present.
      if (includeSystem) {
        if (!navigator.mediaDevices.getDisplayMedia) throw new Error(SYSTEM_AUDIO_ERROR);
        retain(await navigator.mediaDevices.getDisplayMedia({ video: { width: 1, height: 1, frameRate: 1 }, audio: true }), 'system');
      }
      if (includeMic) {
        retain(await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(sources.microphoneDeviceId ? { deviceId: { exact: sources.microphoneDeviceId } } : {}) },
          video: false,
        }), 'mic');
      }
      if (run !== generation) throw new Error('Recording was cancelled.');
      context = new AudioContext();
      await context.resume();
      if (run !== generation) throw new Error('Recording was cancelled.');
      const destination = context.createMediaStreamDestination();
      streams.push(destination.stream);
      nodes.push(destination);
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 12;
      limiter.ratio.value = 8;
      limiter.connect(destination);
      nodes.push(limiter);
      const meters: Array<{ kind: 'mic' | 'system'; analyser: AnalyserNode; values: Float32Array<ArrayBuffer> }> = [];
      for (const input of inputs) {
        // Ignore the display video: only audio enters the saved recording.
        const source = context.createMediaStreamSource(new MediaStream(input.stream.getAudioTracks()));
        const gain = context.createGain();
        gain.gain.value = inputs.length > 1 ? 0.75 : 1;
        source.connect(gain);
        gain.connect(limiter);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        meters.push({ kind: input.kind, analyser, values: new Float32Array(analyser.fftSize) });
        nodes.push(source, gain, analyser);
        for (const track of input.stream.getAudioTracks()) {
          if (track.readyState !== 'live') throw new Error(input.kind === 'system' ? SYSTEM_AUDIO_ERROR : 'The microphone disconnected before recording started.');
          const ended = () => {
            pause();
            options.onError?.(new Error(`${input.kind === 'system' ? 'System audio sharing' : 'The microphone'} ended. The recording has been paused; save it, then start a new recording.`));
          };
          track.addEventListener('ended', ended);
          listeners.push(() => track.removeEventListener('ended', ended));
        }
      }
      const mimeType = preferredRecordingMimeType();
      recorder = new MediaRecorder(destination.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128_000 });
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onerror = event => {
        recorderError = new Error((event as Event & { error?: Error }).error?.message || 'The audio encoder failed. Save the recording to recover captured audio.');
        pause();
        options.onError?.(recorderError);
      };
      recorder.start(1000);
      activeStartedAt = performance.now();
      setState('recording');
      meterTimer = setInterval(() => {
        if (state !== 'recording') return;
        const levels = { mic: 0, system: 0 };
        for (const meter of meters) {
          meter.analyser.getFloatTimeDomainData(meter.values);
          const rms = Math.sqrt(meter.values.reduce((sum, value) => sum + value * value, 0) / meter.values.length);
          levels[meter.kind] = Math.min(1, rms * 4);
        }
        options.onLevels?.(levels);
      }, 80);
    } catch (error) {
      // Only this generation may clean shared resources; a late rejected prompt
      // must not interrupt a newer recording after dispose().
      if (run === generation) {
        cleanResources();
        recorder = null;
        chunks = [];
        setState('idle');
      }
      throw error;
    } finally {
      if (run === generation) starting = false;
    }
  }

  async function stop(): Promise<RecordingResult> {
    if (stopPromise) return stopPromise;
    if (starting) throw new Error('Wait for the audio permission prompt to finish.');
    const current = recorder;
    if (!current || state === 'idle') throw new Error('No recording is active.');
    if (state === 'recording') activeDuration += performance.now() - activeStartedAt;
    stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      const finish = () => {
        const mimeType = current.mimeType || chunks[0]?.type || 'audio/webm';
        const blob = new Blob(chunks, { type: mimeType });
        cleanResources();
        recorder = null;
        chunks = [];
        setState('idle');
        if (!blob.size) reject(recorderError ?? new Error('No audio bytes were captured. Check source permissions and try again.'));
        else resolve({ blob, mimeType, durationMs: Math.max(0, Math.round(activeDuration)) });
      };
      if (current.state === 'inactive') finish();
      else {
        current.onstop = finish;
        try { current.stop(); }
        catch (error) { recorderError = error instanceof Error ? error : new Error('The audio encoder could not stop.'); finish(); }
      }
    });
    try { return await stopPromise; } finally { stopPromise = null; }
  }

  function dispose() {
    generation++;
    starting = false;
    if (!stopPromise && recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    cleanResources();
    if (!stopPromise) { recorder = null; chunks = []; }
    setState('idle');
  }

  return { start, pause, resume, stop, dispose, get state() { return state; } };
}
