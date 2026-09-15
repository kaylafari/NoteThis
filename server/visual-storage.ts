import type { SummaryVisual } from "../shared/types.js";

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
export const MAX_VISUAL_BYTES = 8 * 1024 * 1024;
export function visualFilename(
  meetingId: string,
  visual: SummaryVisual,
): string {
  if (
    ![meetingId, visual.id].every((id) => /^[a-zA-Z0-9-]{1,80}$/.test(id)) ||
    !extensions[visual.mimeType]
  )
    throw new Error("Invalid summary visual identity or image format.");
  return `${meetingId}-${visual.id}.${extensions[visual.mimeType]}`;
}
export function decodeVisual(visual: SummaryVisual): Buffer {
  const prefix = `data:${visual.mimeType};base64,`;
  if (!visual.dataUrl?.startsWith(prefix))
    throw new Error("Invalid summary image data.");
  const encoded = visual.dataUrl.slice(prefix.length);
  if (
    encoded.length > Math.ceil(MAX_VISUAL_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new Error(
      "Summary image exceeds the size limit or contains invalid data.",
    );
  const data = Buffer.from(encoded, "base64");
  if (data.length > MAX_VISUAL_BYTES || data.toString("base64") !== encoded)
    throw new Error("Invalid summary image encoding.");
  const valid =
    visual.mimeType === "image/png"
      ? data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : visual.mimeType === "image/jpeg"
        ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : visual.mimeType === "image/webp" &&
          data.subarray(0, 4).toString() === "RIFF" &&
          data.subarray(8, 12).toString() === "WEBP";
  if (!valid)
    throw new Error("Summary image does not match its raster format.");
  return data;
}
