/** Real Chromium audio/encoder integration. Uses generated signals, never devices. */
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), "cadence-recorder-test-"));
const output = path.join(scratch, "synthetic.webm");
const report = path.join(scratch, "result.json");
try {
  await mkdir(path.join(scratch, "profile"));
  const bundle = await build({
    entryPoints: ["src/recorder.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "CadenceRecorder",
    write: false,
  });
  await writeFile(
    path.join(scratch, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Cadence synthetic recorder verification</title><script>${bundle.outputFiles[0].text}</script>`,
  );
  // This isolated test does not use the production preload or the user's data.
  // Device APIs return generated AudioContext streams; no permission is requested.
  const test = async function () {
    const nativeAudioContext = window.AudioContext;
    const audioContexts = [];
    window.AudioContext = class extends nativeAudioContext {
      constructor(...args) { super(...args); audioContexts.push(this); }
    };
    const synth = new AudioContext();
    await synth.resume();
    const makeTone = (frequency) => {
      const oscillator = synth.createOscillator();
      oscillator.frequency.value = frequency;
      const gain = synth.createGain();
      gain.gain.value = 0.12;
      const destination = synth.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      return { oscillator, destination };
    };
    const microphone = makeTone(220);
    const system = makeTone(440);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: async () => system.destination.stream,
        getUserMedia: async () => microphone.destination.stream,
      },
    });
    const capturedLevels = { mic: 0, system: 0 };
    const recorder = CadenceRecorder.createCallRecorder({
      onLevels(levels) {
        capturedLevels.mic = Math.max(capturedLevels.mic, levels.mic);
        capturedLevels.system = Math.max(capturedLevels.system, levels.system);
      },
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await recorder.start();
    // Wait for real input: a cold audio service can take over a second to render.
    const readyDeadline = performance.now() + 8000;
    while (capturedLevels.mic < 0.01 || capturedLevels.system < 0.01) {
      if (performance.now() > readyDeadline) throw new Error('Synthetic audio did not start rendering: ' + JSON.stringify(audioContexts.map(context => ({state: context.state, seconds: context.currentTime}))));
      await sleep(50);
    }
    await sleep(1000);
    recorder.pause();
    await sleep(250);
    recorder.resume();
    await sleep(1000);
    const clocks = audioContexts.map(context => ({ state: context.state, seconds: context.currentTime, sampleRate: context.sampleRate }));
    let result;
    try { result = await recorder.stop(); }
    catch (error) { throw new Error(JSON.stringify({ message: error.message, clocks, capturedLevels, tracks: system.destination.stream.getTracks().map(track => ({readyState: track.readyState, muted: track.muted})) })); }
    microphone.oscillator.stop();
    system.oscillator.stop();
    await synth.close();
    return {
      bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())),
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      levels: capturedLevels,
      tracksStopped: [
        ...microphone.destination.stream.getTracks(),
        ...system.destination.stream.getTracks(),
      ].every((track) => track.readyState === "ended"),
    };
  };
  const main = `const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(${JSON.stringify(path.join(scratch, "index.html"))});
  const result=await win.webContents.executeJavaScript('('+${JSON.stringify(test.toString())}+')()',true);
  fs.writeFileSync(${JSON.stringify(output)},Buffer.from(result.bytes));
  delete result.bytes;
  fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(result));
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});`;
  const mainFile = path.join(scratch, "main.cjs");
  await writeFile(mainFile, main);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [mainFile], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Synthetic recording test timed out.\n" + logs));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(new Error(`Electron test exited ${code}.\n${logs}`));
    });
  });
  const result = JSON.parse(await readFile(report, "utf8"));
  assert(
    result.durationMs >= 1900 && result.durationMs < 11000,
    `Unexpected active recording duration: ${result.durationMs}`,
  );
  assert(
    result.levels.mic > 0.01 && result.levels.system > 0.01,
    "Both independent input meters must detect signal",
  );
  assert(result.tracksStopped, "Recording must release both input streams");
  const { stdout: info } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,codec_type",
    "-of",
    "json",
    output,
  ]);
  const streams = JSON.parse(info).streams;
  assert.equal(
    streams.length,
    1,
    "Only one mixed audio stream should be saved",
  );
  assert.equal(streams[0].codec_type, "audio");
  assert.equal(streams[0].codec_name, "opus");
  const { stdout: pcm } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      output,
      "-f",
      "f32le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
  );
  const samples = new Float32Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );
  assert(samples.length / 48000 >= 1.7, 'The decoded recording must contain the two seconds of established input');
  const amplitude = (frequency) => {
    let maximum = 0;
    // Complete windows avoid phase cancellation across a paused interval.
    const windowSize = 4800;
    for (let offset = 0; offset + windowSize <= samples.length; offset += windowSize) {
      let real = 0, imaginary = 0;
      for (let i = 0; i < windowSize; i++) {
        real += samples[offset + i] * Math.cos((2 * Math.PI * frequency * i) / 48000);
        imaginary += samples[offset + i] * Math.sin((2 * Math.PI * frequency * i) / 48000);
      }
      maximum = Math.max(maximum, 2 * Math.sqrt(real * real + imaginary * imaginary) / windowSize);
    }
    return maximum;
  };
  const micAmplitude = amplitude(220),
    systemAmplitude = amplitude(440);
  assert(
    micAmplitude > 0.005 && systemAmplitude > 0.005,
    `Decoded recording must contain BOTH tones: mic=${micAmplitude}, system=${systemAmplitude}`,
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        codec: streams[0].codec_name,
        decodedSeconds: samples.length / 48000,
        micAmplitude,
        systemAmplitude,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Chromium mixing, meters, pause/resume, encoding, both decoded sources, and cleanup. Hardware capture remains a separate manual check.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
