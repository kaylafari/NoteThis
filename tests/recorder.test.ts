import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallRecorder, SYSTEM_AUDIO_ERROR } from "../src/recorder";

class Track extends EventTarget {
  readyState = "live";
  stopped = false;
  constructor(public kind: "audio" | "video") {
    super();
  }
  stop() {
    this.readyState = "ended";
    this.stopped = true;
  }
  disconnectSource() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
  gain = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  fftSize = 256;
  getFloatTimeDomainData(values: Float32Array) {
    values.fill(0.2);
  }
}
let contexts: FakeAudioContext[];
class FakeAudioContext {
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = new Node();
  sourceStreams: Stream[] = [];
  constructor() {
    contexts.push(this);
  }
  createMediaStreamDestination() {
    return Object.assign(new Node(), {
      stream: new Stream([new Track("audio")]),
    });
  }
  createDynamicsCompressor() {
    return new Node();
  }
  createGain() {
    return new Node();
  }
  createAnalyser() {
    return new Node();
  }
  createMediaStreamSource(stream: Stream) {
    this.sourceStreams.push(stream);
    return new Node();
  }
}
let encoders: Encoder[];
class Encoder {
  static isTypeSupported(type: string) {
    return type.includes("webm");
  }
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: Stream) {
    encoders.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob(["recorded audio"], { type: this.mimeType }),
      });
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
  display = new Stream([new Track("audio"), new Track("video")]);
  microphone = new Stream([new Track("audio")]);
  getDisplayMedia = vi.fn(async () => display);
  getUserMedia = vi.fn(async () => microphone);
  vi.stubGlobal("navigator", {
    mediaDevices: { getDisplayMedia, getUserMedia },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("MediaRecorder", Encoder);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("call recorder source integrity", () => {
  it("mixes both audio inputs and saves no display video", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    expect(contexts[0].sourceStreams).toHaveLength(2);
    expect(
      contexts[0].sourceStreams.every(
        (stream) => stream.getVideoTracks().length === 0,
      ),
    ).toBe(true);
    expect(encoders[0].stream.getAudioTracks()).toHaveLength(1);
    expect(encoders[0].stream.getVideoTracks()).toHaveLength(0);
    const result = await recorder.stop();
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toBe("audio/webm;codecs=opus");
    expect(display.getTracks().every((track) => track.stopped)).toBe(true);
    expect(microphone.getTracks().every((track) => track.stopped)).toBe(true);
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it("rejects missing system audio without silently recording only the mic", async () => {
    display = new Stream([new Track("video")]);
    const recorder = createCallRecorder();
    await expect(recorder.start()).rejects.toThrow(SYSTEM_AUDIO_ERROR);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(display.getTracks()[0].stopped).toBe(true);
    expect(recorder.state).toBe("idle");
  });

  it("rejects an ended macOS system track even if an audio track exists", async () => {
    display.getAudioTracks()[0].stop();
    await expect(createCallRecorder().start()).rejects.toThrow(
      SYSTEM_AUDIO_ERROR,
    );
    expect(display.getVideoTracks()[0].stopped).toBe(true);
  });

  it("releases acquired screen and system audio when microphone permission fails", async () => {
    getUserMedia.mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await expect(createCallRecorder().start()).rejects.toThrow(
      "Microphone access was not granted",
    );
    expect(display.getTracks().every((track) => track.stopped)).toBe(true);
    expect(encoders).toHaveLength(0);
  });

  it("stops a late permission stream after the UI was disposed", async () => {
    let resolve!: (stream: Stream) => void;
    getDisplayMedia.mockImplementation(
      () =>
        new Promise<Stream>((done) => {
          resolve = done;
        }),
    );
    const recorder = createCallRecorder();
    const pending = recorder.start();
    recorder.dispose();
    resolve(display);
    await expect(pending).rejects.toThrow("cancelled");
    expect(display.getTracks().every((track) => track.stopped)).toBe(true);
    expect(contexts).toHaveLength(0);
  });

  it("pauses and reports source disconnection while keeping recorded bytes saveable", async () => {
    const onError = vi.fn();
    const recorder = createCallRecorder({ onError });
    await recorder.start();
    display.getAudioTracks()[0].disconnectSource();
    expect(recorder.state).toBe("paused");
    expect(onError).toHaveBeenCalledOnce();
    expect(() => recorder.resume()).toThrow("disconnected");
    expect((await recorder.stop()).blob.size).toBeGreaterThan(0);
  });

  it("excludes paused time from the saved duration and supports a second recording", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const recorder = createCallRecorder();
    await recorder.start({ includeSystem: false });
    now = 1000;
    recorder.pause();
    now = 9000;
    recorder.resume();
    now = 9500;
    expect((await recorder.stop()).durationMs).toBe(1500);
    microphone = new Stream([new Track("audio")]);
    await recorder.start({ includeSystem: false });
    expect(recorder.state).toBe("recording");
    await recorder.stop();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("rejects overlapping starts and empty source selection", async () => {
    const recorder = createCallRecorder();
    await expect(
      recorder.start({ includeSystem: false, includeMic: false }),
    ).rejects.toThrow("Choose");
    await recorder.start({ includeSystem: false });
    await expect(recorder.start()).rejects.toThrow("already active");
    recorder.dispose();
    expect(microphone.getTracks().every((track) => track.stopped)).toBe(true);
  });

  it("releases all inputs and the audio graph when the encoder cannot start", async () => {
    vi.spyOn(Encoder.prototype, "start").mockImplementation(() => {
      throw new Error("Encoder unavailable");
    });
    const recorder = createCallRecorder();
    await expect(recorder.start()).rejects.toThrow("Encoder unavailable");
    expect(display.getTracks().every((track) => track.stopped)).toBe(true);
    expect(microphone.getTracks().every((track) => track.stopped)).toBe(true);
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("idle");
  });

  it("recovers existing bytes and releases inputs if the encoder throws on stop", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    encoders[0].ondataavailable?.({ data: new Blob(["recoverable audio"]) });
    vi.spyOn(encoders[0], "stop").mockImplementation(() => {
      throw new Error("Encoder already stopped");
    });
    const result = await recorder.stop();
    expect(await result.blob.text()).toBe("recoverable audio");
    expect(display.getTracks().every((track) => track.stopped)).toBe(true);
    expect(microphone.getTracks().every((track) => track.stopped)).toBe(true);
    expect(recorder.state).toBe("idle");
  });

  it("pauses when screen sharing ends even if the system audio track stays live", async () => {
    const onError = vi.fn();
    const recorder = createCallRecorder({ onError });
    await recorder.start();
    display.getVideoTracks()[0].disconnectSource();
    expect(display.getAudioTracks()[0].readyState).toBe("live");
    expect(recorder.state).toBe("paused");
    expect(onError).toHaveBeenCalledOnce();
    expect(() => recorder.resume()).toThrow("disconnected");
    expect((await recorder.stop()).blob.size).toBeGreaterThan(0);
  });
});

describe("permission request feedback", () => {
  it("waits for the actual system request before reporting an actionable denial", async () => {
    vi.stubGlobal("window", {
      desktop: { isElectron: true, platform: "darwin" },
    });
    let deny!: (error: Error) => void;
    getDisplayMedia.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          deny = reject;
        }),
    );
    const onPermissionRequest = vi.fn();
    const recorder = createCallRecorder({ onPermissionRequest });
    const result = recorder.start();
    const rejected = expect(result).rejects.toThrow(
      /System audio.*Screen & System Audio Recording.*Cadence/,
    );
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(onPermissionRequest.mock.calls).toEqual([["system"]]);
    expect(recorder.state).toBe("idle");
    expect(encoders).toHaveLength(0);
    deny(new DOMException("Permission denied", "NotAllowedError"));
    await rejected;
    expect(onPermissionRequest.mock.calls).toEqual([["system"], [null]]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests the microphone on every attempt and names the macOS permission", async () => {
    vi.stubGlobal("window", {
      desktop: { isElectron: true, platform: "darwin" },
    });
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    const onPermissionRequest = vi.fn();
    const recorder = createCallRecorder({ onPermissionRequest });
    await expect(recorder.start({ includeSystem: false })).rejects.toThrow(
      /Microphone.*Privacy & Security → Microphone.*enable Cadence/,
    );
    expect(onPermissionRequest.mock.calls).toEqual([["microphone"], [null]]);
    await recorder.start({ includeSystem: false });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  it("requests display synchronously before microphone so the click remains active", async () => {
    const order: string[] = [];
    getDisplayMedia.mockImplementation(async () => {
      order.push("system");
      return display;
    });
    getUserMedia.mockImplementation(async () => {
      order.push("microphone");
      return microphone;
    });
    const recorder = createCallRecorder({
      onPermissionRequest: (source) => order.push(String(source)),
    });
    const starting = recorder.start();
    expect(order).toEqual(["system", "system"]);
    await starting;
    expect(order).toEqual([
      "system",
      "system",
      "null",
      "microphone",
      "microphone",
      "null",
    ]);
    await recorder.stop();
  });

  it("only requests system access when microphone is deselected", async () => {
    const onPermissionRequest = vi.fn();
    const recorder = createCallRecorder({ onPermissionRequest });
    await recorder.start({ includeMic: false });
    expect(onPermissionRequest.mock.calls).toEqual([["system"], [null]]);
    expect(getUserMedia).not.toHaveBeenCalled();
    await recorder.stop();
  });

  it("gives browser-specific permission recovery instructions", async () => {
    getUserMedia.mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await expect(
      createCallRecorder().start({ includeSystem: false }),
    ).rejects.toThrow(/Microphone for this site.*browser.*site settings/);
  });

  it.each(["NotFoundError", "OverconstrainedError"])(
    "does not label %s as a permission denial",
    async (name) => {
      getUserMedia.mockRejectedValue(new DOMException("Unavailable", name));
      await expect(
        createCallRecorder().start({ includeSystem: false }),
      ).rejects.toThrow("Microphone source is unavailable");
    },
  );

  it("names system capture failures without claiming the microphone was denied", async () => {
    getDisplayMedia.mockRejectedValue(
      new DOMException("Could not start", "NotReadableError"),
    );
    await expect(createCallRecorder().start()).rejects.toThrow(
      "System audio / screen sharing could not start",
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("treats a rejected prompt after disposal as cancellation", async () => {
    let deny!: (error: Error) => void;
    getDisplayMedia.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          deny = reject;
        }),
    );
    const recorder = createCallRecorder();
    const result = recorder.start();
    const rejected = expect(result).rejects.toThrow("Recording was cancelled");
    recorder.dispose();
    deny(new DOMException("Denied", "NotAllowedError"));
    await rejected;
    expect(contexts).toHaveLength(0);
  });
});
