import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
export async function verifyRuntimeAudio(directory) {
  const runtime = path.resolve(directory);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "notethis-audio-runtime-"),
  );
  const { fixtures } = JSON.parse(
    await readFile(new URL("./audio-fixtures.json", import.meta.url), "utf8"),
  );
  const env = { PATH: "/usr/bin:/bin", HOME: temporary, LANG: "C" };
  const formats = [];
  try {
    for (const fixture of fixtures) {
      const input = path.join(temporary, `tone.${fixture.extension}`);
      const output = path.join(temporary, "decoded.wav");
      await writeFile(input, Buffer.from(fixture.base64, "base64"));
      const decode = spawnSync(
        path.join(runtime, "bin/ffmpeg"),
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          input,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-y",
          output,
        ],
        { env, encoding: "utf8", timeout: 20_000 },
      );
      if (decode.status !== 0)
        throw new Error(
          `${fixture.extension} decoding failed: ${decode.stderr}`,
        );
      const probe = spawnSync(
        path.join(runtime, "bin/ffprobe"),
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          output,
        ],
        { env, encoding: "utf8", timeout: 20_000 },
      );
      const duration = Number(probe.stdout?.trim());
      if (probe.status !== 0 || duration < 0.1 || duration > 0.5)
        throw new Error(`${fixture.extension} probe failed: ${probe.stderr}`);
      const nullSink = spawnSync(
        path.join(runtime, "bin/ffmpeg"),
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          input,
          "-map",
          "0:a:0",
          "-vn",
          "-f",
          "null",
          "-",
          "-progress",
          "pipe:1",
          "-nostats",
        ],
        { env, encoding: "utf8", timeout: 20_000 },
      );
      if (nullSink.status !== 0 || !/out_time_us=\d+/.test(nullSink.stdout))
        throw new Error(
          `${fixture.extension} streaming duration failed: ${nullSink.stderr}`,
        );
      formats.push(fixture.extension);
    }
    return formats;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(
      await verifyRuntimeAudio(process.argv[2] || "build/runtime"),
    ),
  );
