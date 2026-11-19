/** Browser audio graph used by the desktop app and the browser upload/record flow. */
export type RecorderState = "idle" | "recording" | "paused";
export type RecordingPermissionSource = "microphone" | "system";
export interface RecorderOptions {
  /** Only active while a selected source is actually requesting access. */
  onPermissionRequest?: (source: RecordingPermissionSource | null) => void;
  onLevels?: (levels: { mic: number; system: number }) => void;
  onStateChange?: (state: RecorderState) => void;
  onError?: (error: Error) => void;
  onRecovery?: (message: string | null, reconnecting: boolean) => void;
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

export const SYSTEM_AUDIO_ERROR =
  "No live system-audio track was received. In the desktop app, allow System Audio Recording (and Screen Recording if requested) in macOS System Settings → Privacy & Security, then restart the app. In a browser, choose a tab with Share audio enabled, or use the desktop app to record the whole call.";

/** Attach recovery instructions to the source that actually failed to open. */
function sourceRequestError(
  source: RecordingPermissionSource,
  error: unknown,
): Error {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const label =
    source === "microphone" ? "Microphone" : "System audio / screen sharing";
  const desktop = typeof window !== "undefined" && window.desktop?.isElectron;
  const mac = desktop && window.desktop?.platform === "darwin";
  const recovery = mac
    ? source === "microphone"
      ? "In macOS System Settings → Privacy & Security → Microphone, enable NoteThis, then quit and reopen the app. macOS does not repeat the prompt after a previous denial."
      : "In macOS System Settings → Privacy & Security → Screen & System Audio Recording (or Screen Recording), allow NoteThis to record system audio and the screen if requested, then quit and reopen the app. macOS may remember a previous denial."
    : desktop
      ? "Allow the selected recording source in your operating system’s privacy settings, then reopen NoteThis."
      : source === "microphone"
        ? "Allow Microphone for this site in your browser’s site settings and allow the browser under your operating system’s microphone privacy settings, then retry."
        : "Retry and select a tab or screen with Share audio enabled. If access is blocked, allow your browser under your operating system’s screen/system audio recording privacy settings.";
  if (
    ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(
      name,
    ) ||
    /permission denied/i.test(message)
  ) {
    return new Error(
      `${label} access was not granted. The request was declined, canceled, or blocked by a saved permission setting. ${recovery}`,
    );
  }
  if (
    ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(
      name,
    )
  ) {
    return new Error(
      `${label} source is unavailable. ${source === "microphone" ? "Connect or select a working microphone and retry." : "Choose an available screen or tab with audio and retry."}`,
    );
  }
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(name)) {
    return new Error(
      `${label} could not start. Another app or the operating system may be blocking capture. ${recovery}`,
    );
  }
  if (name === "InvalidStateError" && source === "system") {
    return new Error(
      "System audio / screen sharing needs an active window. Focus NoteThis and click Start recording again.",
    );
  }
  return new Error(
    `${label} could not start: ${message || "Unknown capture error"}`,
  );
}

export function preferredRecordingMimeType(): string {
  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) ?? ""
  );
}

export function createCallRecorder(options: RecorderOptions = {}) {
  let state: RecorderState = "idle";
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

  type Input = {
    kind: "mic" | "system";
    stream: MediaStream;
    nodes?: AudioNode[];
    remove?: Array<() => void>;
    analyser?: AnalyserNode;
    values?: Float32Array<ArrayBuffer>;
  };
  let inputs: Input[] = [];
  let selectedSources: RecordingSources = {};
  let limiter: DynamicsCompressorNode | null = null;
  let recovery: Promise<void> | null = null;
  let autoResume = true;
  let interrupted = false;
  let sleeping = false;
  let lastLiveAt = 0;
  let resumeIntent = 0;

  function setState(next: RecorderState) {
    state = next;
    options.onStateChange?.(next);
  }

  function cleanResources() {
    clearInterval(meterTimer);
    meterTimer = undefined;
    for (const remove of listeners) remove();
    listeners = [];
    inputs.forEach((input) => input.remove?.forEach((remove) => remove()));
    for (const stream of streams)
      for (const track of stream.getTracks()) track.stop();
    streams = [];
    inputs = [];
    limiter = null;
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    nodes = [];
    if (context) void context.close().catch(() => undefined);
    context = null;
    options.onLevels?.({ mic: 0, system: 0 });
  }

  function pauseCapture(interruption = false) {
    if (state !== "recording" || !recorder) return;
    if (recorder.state === "recording") recorder.pause();
    // A throttled renderer may first notice sleep after waking. Do not count
    // the unobserved gap as recorded audio.
    const now = performance.now();
    const end = interruption && now - lastLiveAt > 5000 ? lastLiveAt : now;
    activeDuration += Math.max(0, end - activeStartedAt);
    setState("paused");
    options.onLevels?.({ mic: 0, system: 0 });
  }
  function pause() {
    resumeIntent++;
    interrupted = false;
    pauseCapture();
    options.onRecovery?.(null, false);
  }
  function interrupt(message: string) {
    if (state !== "recording") return;
    interrupted = true;
    pauseCapture(true);
    options.onRecovery?.(message, false);
  }
  const ended = (input: Input) =>
    input.stream.getTracks().some((track) => track.readyState !== "live");
  const muted = () =>
    inputs.some((input) =>
      input.stream.getAudioTracks().some((track) => track.muted),
    );
  async function requestSource(
    source: RecordingPermissionSource,
    request: () => Promise<MediaStream>,
    run: number,
  ) {
    options.onPermissionRequest?.(source);
    try {
      const stream = await request(); // Invoked before any await: preserve click activation.
      if (run !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Recording was cancelled.");
      }
      return stream;
    } catch (error) {
      if (run !== generation) throw new Error("Recording was cancelled.");
      throw sourceRequestError(source, error);
    } finally {
      if (run === generation) options.onPermissionRequest?.(null);
    }
  }
  function acquire(kind: "mic" | "system", run: number) {
    return requestSource(
      kind === "mic" ? "microphone" : "system",
      () =>
        kind === "system"
          ? navigator.mediaDevices.getDisplayMedia({
              video: { width: 1, height: 1, frameRate: 1 },
              audio: true,
            })
          : navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(selectedSources.microphoneDeviceId
                  ? { deviceId: { exact: selectedSources.microphoneDeviceId } }
                  : {}),
              },
              video: false,
            }),
      run,
    );
  }
  function validateInput(stream: MediaStream, kind: "mic" | "system") {
    if (
      !stream.getAudioTracks().length ||
      stream.getTracks().some((track) => track.readyState !== "live")
    )
      throw new Error(
        kind === "system"
          ? SYSTEM_AUDIO_ERROR
          : "No live microphone track was received. Reconnect the microphone and click Resume.",
      );
  }
  function detach(input: Input) {
    input.remove?.forEach((remove) => remove());
    input.nodes?.forEach((node) => {
      try {
        node.disconnect();
      } catch {}
    });
    nodes = nodes.filter((node) => !input.nodes?.includes(node));
    input.stream.getTracks().forEach((track) => track.stop());
    streams = streams.filter((stream) => stream !== input.stream);
  }
  function attach(input: Input) {
    validateInput(input.stream, input.kind);
    const source = context!.createMediaStreamSource(
      new MediaStream(input.stream.getAudioTracks()),
    );
    const gain = context!.createGain();
    gain.gain.value = inputs.length > 1 ? 0.75 : 1;
    source.connect(gain);
    gain.connect(limiter!);
    const analyser = context!.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    input.nodes = [source, gain, analyser];
    input.analyser = analyser;
    input.values = new Float32Array(analyser.fftSize);
    input.remove = [];
    for (const track of input.stream.getTracks()) {
      const lost = () =>
        interrupt(
          `${input.kind === "system" ? "System audio" : "Microphone"} disconnected. Captured audio is kept. Click Resume to reconnect.`,
        );
      const silenced = () =>
        interrupt(
          "Audio is temporarily unavailable. Waiting for the source to return; you can also click Resume.",
        );
      const restored = () => {
        void tryAutoResume();
      };
      for (const [event, handler] of [
        ["ended", lost],
        ["mute", silenced],
        ["unmute", restored],
      ] as const) {
        track.addEventListener(event, handler);
        input.remove.push(() => track.removeEventListener(event, handler));
      }
    }
    nodes.push(...input.nodes);
  }
  async function tryAutoResume() {
    if (
      !autoResume ||
      !interrupted ||
      sleeping ||
      recovery ||
      state !== "paused"
    )
      return;
    // Never open a new screen-sharing picker without a Resume click.
    if (inputs.some((input) => input.kind === "system" && ended(input))) {
      options.onRecovery?.(
        "System audio needs to be shared again. Click Resume to reconnect; earlier audio is kept.",
        false,
      );
      return;
    }
    if (muted()) return;
    try {
      await resume(true);
    } catch {
      /* Manual retry remains available. */
    }
  }
  function resume(automatic = false): Promise<void> {
    if (recovery) return recovery;
    if (state !== "paused") return Promise.resolve();
    const run = generation;
    const intent = resumeIntent;
    options.onRecovery?.("Reconnecting audio…", true);
    const work = async () => {
      if (
        !recorder ||
        recorder.state !== "paused" ||
        recorderError ||
        !context ||
        context.state === "closed"
      )
        throw new Error(
          "Audio capture has stopped. Choose Finish recording to recover captured audio, then start a new recording.",
        );
      // Display is first and synchronous to retain the Resume click's activation.
      for (const input of [...inputs].sort((a, b) =>
        a.kind === b.kind ? 0 : a.kind === "system" ? -1 : 1,
      )) {
        if (
          !ended(input) &&
          (automatic ||
            !input.stream.getAudioTracks().some((track) => track.muted))
        )
          continue;
        const replacement = await acquire(input.kind, run);
        try {
          if (run !== generation) throw new Error("Recording was cancelled.");
          validateInput(replacement, input.kind);
          detach(input);
          input.stream = replacement;
          streams.push(replacement);
          attach(input);
        } catch (error) {
          replacement.getTracks().forEach((track) => track.stop());
          throw error;
        }
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          context.resume(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Audio did not wake up yet. Click Resume to try again, or Finish recording to save captured audio.",
                  ),
                ),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (run !== generation) throw new Error("Recording was cancelled.");
      if (intent !== resumeIntent)
        throw new Error("Recording remains paused. Click Resume when ready.");
      if (automatic && !autoResume)
        throw new Error("Automatic resume is off. Click Resume when ready.");
      if (
        sleeping ||
        context.state !== "running" ||
        muted() ||
        inputs.some(ended)
      )
        throw new Error(
          "Audio is still unavailable. Reconnect the selected sources and click Resume again. Captured audio is kept.",
        );
      recorder.resume();
      interrupted = false;
      activeStartedAt = lastLiveAt = performance.now();
      setState("recording");
      options.onRecovery?.(
        "Recording resumed. Audio captured before the interruption is kept; time asleep is not recorded.",
        false,
      );
    };
    recovery = work()
      .catch((error) => {
        if (run === generation)
          options.onRecovery?.(
            `${automatic ? "Automatic reconnection could not finish. " : ""}${(error as Error).message}`,
            false,
          );
        throw error;
      })
      .finally(() => {
        if (run === generation) recovery = null;
      });
    return recovery;
  }

  async function start(sources: RecordingSources = {}) {
    if (starting || state !== "idle" || stopPromise)
      throw new Error("A recording is already active.");
    const includeMic = sources.includeMic ?? true;
    const includeSystem = sources.includeSystem ?? true;
    if (!includeMic && !includeSystem)
      throw new Error("Choose microphone audio, system audio, or both.");
    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined")
      throw new Error(
        "Recording is not supported here. Open the desktop app or a current browser on localhost.",
      );
    starting = true;
    selectedSources = { ...sources };
    interrupted = false;
    sleeping = false;
    inputs = [];
    options.onRecovery?.(null, false);
    const run = ++generation;
    chunks = [];
    activeDuration = 0;
    recorderError = null;

    // A pending permission prompt can outlive dispose(). Never retain its late stream.
    function retain(stream: MediaStream, kind: "mic" | "system") {
      if (run !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Recording was cancelled.");
      }
      streams.push(stream);
      inputs.push({ kind, stream });
      const audio = stream.getAudioTracks();
      if (!audio.length || audio.some((track) => track.readyState !== "live")) {
        throw new Error(
          kind === "system"
            ? SYSTEM_AUDIO_ERROR
            : "No live microphone track was received. Check microphone permission and the selected input device.",
        );
      }
    }
    try {
      // Request display first, while the Start button's user activation is present.
      if (includeSystem) {
        if (!navigator.mediaDevices.getDisplayMedia)
          throw new Error(SYSTEM_AUDIO_ERROR);
        retain(await acquire("system", run), "system");
      }
      if (includeMic) retain(await acquire("mic", run), "mic");
      if (run !== generation) throw new Error("Recording was cancelled.");
      context = new AudioContext();
      await context.resume();
      if (run !== generation) throw new Error("Recording was cancelled.");
      const destination = context.createMediaStreamDestination();
      streams.push(destination.stream);
      nodes.push(destination);
      limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 12;
      limiter.ratio.value = 8;
      limiter.connect(destination);
      nodes.push(limiter);
      inputs.forEach(attach);
      const mimeType = preferredRecordingMimeType();
      recorder = new MediaRecorder(destination.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 128_000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        recorderError = new Error(
          (event as Event & { error?: Error }).error?.message ||
            "The audio encoder failed. Save the recording to recover captured audio.",
        );
        pause();
        options.onError?.(recorderError);
      };
      recorder.start(1000);
      activeStartedAt = lastLiveAt = performance.now();
      setState("recording");
      if (muted())
        interrupt(
          "Audio is not available yet. Waiting for the selected sources, or click Resume to reconnect.",
        );
      meterTimer = setInterval(() => {
        if (state !== "recording") return;
        const levels = { mic: 0, system: 0 };
        const now = performance.now();
        if (now - lastLiveAt > 5000) {
          interrupt(
            "Recording paused while the computer was asleep. Reconnecting when audio is available.",
          );
          void tryAutoResume();
          return;
        }
        lastLiveAt = now;
        for (const input of inputs) {
          input.analyser!.getFloatTimeDomainData(input.values!);
          const rms = Math.sqrt(
            input.values!.reduce((sum, value) => sum + value * value, 0) /
              input.values!.length,
          );
          levels[input.kind] = Math.min(1, rms * 4);
        }
        options.onLevels?.(levels);
      }, 80);
      const wake = () => {
        void tryAutoResume();
      };
      const contextChanged = () => {
        if (context?.state === "closed") {
          interrupt(
            "The audio engine stopped. Finish recording to save captured audio, then start a new recording.",
          );
          return;
        }
        if (
          context?.state === "suspended" ||
          (context?.state as string) === "interrupted"
        )
          interrupt(
            "Audio paused after a system interruption. It will resume when available, or click Resume.",
          );
        else if (context?.state === "running") wake();
      };
      const audioContext = context;
      audioContext.addEventListener("statechange", contextChanged);
      listeners.push(() =>
        audioContext.removeEventListener("statechange", contextChanged),
      );
      navigator.mediaDevices.addEventListener?.("devicechange", wake);
      listeners.push(() =>
        navigator.mediaDevices.removeEventListener?.("devicechange", wake),
      );
      if (typeof window !== "undefined") {
        window.addEventListener?.("focus", wake);
        listeners.push(() => window.removeEventListener?.("focus", wake));
        const unsubscribe = window.desktop?.onPowerState?.((event) => {
          sleeping = event === "suspend";
          if (sleeping)
            interrupt(
              "Computer asleep. Captured audio is kept; recording can resume after wake.",
            );
          else wake();
        });
        if (unsubscribe) listeners.push(unsubscribe);
      }
    } catch (error) {
      // Only this generation may clean shared resources; a late rejected prompt
      // must not interrupt a newer recording after dispose().
      if (run === generation) {
        cleanResources();
        recorder = null;
        chunks = [];
        setState("idle");
      }
      throw error;
    } finally {
      if (run === generation) starting = false;
    }
  }

  async function stop(): Promise<RecordingResult> {
    if (stopPromise) return stopPromise;
    if (starting)
      throw new Error("Wait for the audio permission prompt to finish.");
    generation++;
    recovery = null;
    interrupted = false;
    options.onRecovery?.(null, false);
    options.onPermissionRequest?.(null);
    const current = recorder;
    if (!current || state === "idle")
      throw new Error("No recording is active.");
    if (state === "recording")
      activeDuration += performance.now() - activeStartedAt;
    stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      const finish = () => {
        const mimeType = current.mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        cleanResources();
        recorder = null;
        chunks = [];
        setState("idle");
        if (!blob.size)
          reject(
            recorderError ??
              new Error(
                "No audio bytes were captured. Check source permissions and try again.",
              ),
          );
        else
          resolve({
            blob,
            mimeType,
            durationMs: Math.max(0, Math.round(activeDuration)),
          });
      };
      if (current.state === "inactive") finish();
      else {
        current.onstop = finish;
        try {
          current.stop();
        } catch (error) {
          recorderError =
            error instanceof Error
              ? error
              : new Error("The audio encoder could not stop.");
          finish();
        }
      }
    });
    try {
      return await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  function dispose() {
    generation++;
    recovery = null;
    interrupted = false;
    options.onRecovery?.(null, false);
    options.onPermissionRequest?.(null);
    starting = false;
    if (!stopPromise && recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    cleanResources();
    if (!stopPromise) {
      recorder = null;
      chunks = [];
    }
    setState("idle");
  }

  return {
    start,
    pause,
    resume,
    stop,
    dispose,
    setAutoResume(enabled: boolean) {
      autoResume = enabled;
      if (enabled) void tryAutoResume();
    },
    get durationMs() {
      return (
        activeDuration +
        (state === "recording"
          ? Math.max(0, performance.now() - activeStartedAt)
          : 0)
      );
    },
    get state() {
      return state;
    },
  };
}
