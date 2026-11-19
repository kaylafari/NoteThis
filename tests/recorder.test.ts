import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallRecorder, SYSTEM_AUDIO_ERROR } from "../src/recorder";

class Track extends EventTarget {
  readyState = "live";
  stopped = false;
  muted = false;
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
class FakeAudioContext extends EventTarget {
  state = "running";
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {});
  destination = new Node();
  sourceStreams: Stream[] = [];
  constructor() {
    super();
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
  onerror: ((event: Event) => void) | null = null;
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
    const onRecovery = vi.fn();
    const recorder = createCallRecorder({ onRecovery });
    await recorder.start();
    display.getAudioTracks()[0].disconnectSource();
    expect(recorder.state).toBe("paused");
    expect(onRecovery).toHaveBeenLastCalledWith(
      expect.stringContaining("Resume"),
      false,
    );
    const replacement = new Stream([new Track("audio"), new Track("video")]);
    getDisplayMedia.mockResolvedValueOnce(replacement);
    await recorder.resume();
    expect(recorder.state).toBe("recording");
    expect(encoders).toHaveLength(1);
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
    await recorder.resume();
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
    const onRecovery = vi.fn();
    const recorder = createCallRecorder({ onRecovery });
    await recorder.start();
    display.getVideoTracks()[0].disconnectSource();
    expect(display.getAudioTracks()[0].readyState).toBe("live");
    expect(recorder.state).toBe("paused");
    expect(onRecovery).toHaveBeenLastCalledWith(
      expect.stringContaining("Resume"),
      false,
    );
    const replacement = new Stream([new Track("audio"), new Track("video")]);
    getDisplayMedia.mockResolvedValueOnce(replacement);
    await recorder.resume();
    expect(recorder.state).toBe("recording");
    expect(encoders).toHaveLength(1);
    expect((await recorder.stop()).blob.size).toBeGreaterThan(0);
  });
});

describe("permission request feedback", () => {
  it("does not silently resume a failed encoder and preserves captured bytes", async () => {
    const onError = vi.fn();
    const recorder = createCallRecorder({ onError });
    await recorder.start();
    encoders[0].ondataavailable?.({ data: new Blob(["recoverable audio"]) });
    encoders[0].state = "inactive";
    encoders[0].onerror?.(new Event("error"));
    expect(recorder.state).toBe("paused");
    await expect(recorder.resume()).rejects.toThrow(/Finish recording/);
    expect(recorder.state).toBe("paused");
    const result = await recorder.stop();
    expect(await result.blob.text()).toBe("recoverable audio");
  });
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
      /System audio.*Screen & System Audio Recording.*NoteThis/,
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
      /Microphone.*Privacy & Security → Microphone.*enable NoteThis/,
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

describe("recording reconnection", () => {
  it("keeps captured bytes when permission is denied, then allows retry", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    encoders[0].ondataavailable?.({ data: new Blob(["before-sleep"]) });
    display.getAudioTracks()[0].disconnectSource();
    getDisplayMedia.mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    await expect(recorder.resume()).rejects.toThrow("access was not granted");
    expect(recorder.state).toBe("paused");
    const replacement = new Stream([new Track("audio")]);
    getDisplayMedia.mockResolvedValueOnce(replacement);
    await recorder.resume();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(encoders).toHaveLength(1);
    expect(await (await recorder.stop()).blob.text()).toContain("before-sleep");
  });
  it("requests replacement display synchronously and stops late streams after Finish", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    display.getVideoTracks()[0].disconnectSource();
    let resolve!: (stream: Stream) => void;
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<Stream>((r) => {
          resolve = r;
        }),
    );
    const pending = recorder.resume();
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    await recorder.stop();
    const late = new Stream([new Track("audio")]);
    resolve(late);
    await expect(pending).rejects.toThrow("cancelled");
    expect(late.getTracks()[0].stopped).toBe(true);
    expect(recorder.state).toBe("idle");
  });
  it("automatically resumes recovered muted tracks but respects a manual pause", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    const track = microphone.getAudioTracks()[0];
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    expect(recorder.state).toBe("paused");
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    recorder.pause();
    track.dispatchEvent(new Event("unmute"));
    await Promise.resolve();
    expect(recorder.state).toBe("paused");
    recorder.dispose();
  });
  it("pauses on system sleep, auto-resumes on wake, and excludes the sleep gap", async () => {
    let notify!: (state: string) => void;
    const unsubscribe = vi.fn();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        desktop: {
          onPowerState: (callback: any) => {
            notify = callback;
            return unsubscribe;
          },
        },
      }),
    );
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const recorder = createCallRecorder();
    await recorder.start();
    now = 1000;
    notify("suspend");
    expect(recorder.state).toBe("paused");
    now = 100000;
    notify("resume");
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    now = 101000;
    expect((await recorder.stop()).durationMs).toBe(2000);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("reconnection controls and cancellation", () => {
  it("serializes repeated Resume clicks and releases a late replacement after discard", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    microphone.getAudioTracks()[0].disconnectSource();
    let deliver!: (stream: Stream) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<Stream>((resolve) => {
          deliver = resolve;
        }),
    );
    const first = recorder.resume();
    const second = recorder.resume();
    expect(first).toBe(second);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    recorder.dispose();
    const late = new Stream([new Track("audio")]);
    deliver(late);
    await expect(first).rejects.toThrow("cancelled");
    expect(late.getTracks()[0].stopped).toBe(true);
  });
  it("auto-recovers a microphone on devicechange without reopening system sharing", async () => {
    const devices = Object.assign(new EventTarget(), {
      getUserMedia,
      getDisplayMedia,
    });
    vi.stubGlobal("navigator", { mediaDevices: devices });
    const recorder = createCallRecorder();
    await recorder.start();
    microphone.getAudioTracks()[0].disconnectSource();
    getUserMedia.mockResolvedValueOnce(new Stream([new Track("audio")]));
    devices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    recorder.dispose();
  });
  it("never opens system sharing automatically on wake and supports opting out", async () => {
    let power!: (value: string) => void;
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        desktop: {
          onPowerState: (callback: any) => {
            power = callback;
            return () => {};
          },
        },
      }),
    );
    const recorder = createCallRecorder();
    await recorder.start();
    display.getAudioTracks()[0].disconnectSource();
    power("resume");
    await Promise.resolve();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(recorder.state).toBe("paused");
    getDisplayMedia.mockResolvedValueOnce(new Stream([new Track("audio")]));
    await recorder.resume();
    recorder.setAutoResume(false);
    power("suspend");
    power("resume");
    await Promise.resolve();
    expect(recorder.state).toBe("paused");
    await recorder.resume();
    recorder.pause();
    power("suspend");
    power("resume");
    expect(recorder.state).toBe("paused");
    recorder.dispose();
  });
  it("revives a suspended AudioContext without creating another encoder", async () => {
    const surface = new EventTarget();
    vi.stubGlobal("window", surface);
    const recorder = createCallRecorder();
    await recorder.start();
    contexts[0].state = "suspended";
    contexts[0].dispatchEvent(new Event("statechange"));
    expect(recorder.state).toBe("paused");
    surface.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    expect(contexts[0].resume).toHaveBeenCalledTimes(2);
    expect(encoders).toHaveLength(1);
    recorder.dispose();
  });
});

describe("late recovery and truthful capture state", () => {
  it("manual Pause wins over a pending automatic resume", async () => {
    const recorder = createCallRecorder();
    await recorder.start();
    const track = microphone.getAudioTracks()[0];
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    let resolve!: () => void;
    contexts[0].resume.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    recorder.pause();
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(recorder.state).toBe("paused");
    await recorder.resume();
    expect(recorder.state).toBe("recording");
    recorder.dispose();
  });
  it("waits for initially-muted input and pauses if the context closes", async () => {
    const recorder = createCallRecorder();
    const track = microphone.getAudioTracks()[0];
    track.muted = true;
    await recorder.start();
    expect(recorder.state).toBe("paused");
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    contexts[0].state = "closed";
    contexts[0].dispatchEvent(new Event("statechange"));
    expect(recorder.state).toBe("paused");
    await expect(recorder.resume()).rejects.toThrow("Finish recording");
    recorder.dispose();
  });
});
