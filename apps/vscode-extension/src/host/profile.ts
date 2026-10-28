// The user's profile in Jesutobits: a name and a picture, kept on this computer only (the
// name in settings, the picture in the extension's global state). Jesutobits has no accounts
// of its own and OpenRouter shares no name or picture, so nothing here leaves the machine.
import { extname } from "node:path";

/** The picture is shown at 28 to 96 px; a larger file only slows the title bar down. */
export const MAX_PICTURE_BYTES = 1024 * 1024;

const PICTURE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The file types the picture dialog offers. */
export const PICTURE_EXTENSIONS = Object.keys(PICTURE_TYPES).map((ext) => ext.slice(1));

/** A `data:` URL for the picture, or the reason it cannot be used. */
export function pictureDataUrl(
  fileName: string,
  bytes: Uint8Array,
): { url: string } | { problem: string } {
  const type = PICTURE_TYPES[extname(fileName).toLowerCase()];
  if (!type) return { problem: "Choose a PNG, JPEG, GIF or WebP picture." };
  if (bytes.byteLength > MAX_PICTURE_BYTES) {
    return { problem: "Choose a picture smaller than 1 MB." };
  }
  if (bytes.byteLength === 0) return { problem: "That picture is empty." };
  return { url: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` };
}

/** Only `data:image/...;base64,` URLs that this module made are ever shown. */
export function isPictureDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PICTURE_BYTES * 2 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
  );
}

/** The name to show: the one the user gave, else the computer's user name, tidied. */
export function displayName(setting: unknown, osUser: string): string {
  const given = typeof setting === "string" ? setting.trim().slice(0, 60) : "";
  if (given) return given;
  const fallback = osUser.trim();
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : "You";
}
