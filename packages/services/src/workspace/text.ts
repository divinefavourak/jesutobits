/**
 * Text decoding and encoding that keeps a file's byte order mark and line endings
 * (AGENT_HARNESS.md section 6, ARCHITECTURE.md section 11).
 */

export type LineEndings = "lf" | "crlf" | "mixed" | "none";

export interface TextFormat {
  /** The file starts with a UTF-8 byte order mark. */
  bom: boolean;
  eol: LineEndings;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** Git's heuristic: a NUL in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

export type Decoded = { binary: false; text: string; format: TextFormat } | { binary: true };

/** UTF-8 only. NULs or invalid UTF-8 (including UTF-16 files) count as binary. */
export function decodeText(bytes: Buffer): Decoded {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true };
  const bom = bytes.subarray(0, 3).equals(UTF8_BOM);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    return { binary: true };
  }
  return { binary: false, text, format: { bom, eol: detectLineEndings(text) } };
}

export function detectLineEndings(text: string): LineEndings {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf === 0 && lf === 0) return "none";
  if (crlf === 0) return "lf";
  if (lf === 0) return "crlf";
  return "mixed";
}

/**
 * Encodes `text` for a file whose existing format was `original`. When the file used one
 * consistent style, new text is converted to it, so an LF edit to a CRLF file stays CRLF.
 * Mixed files and new files keep the text exactly as given. The BOM is kept or left out
 * as before.
 */
export function encodeText(text: string, original: TextFormat | undefined): Buffer {
  let out = text;
  if (original?.eol === "crlf") out = text.replace(/\r?\n/g, "\r\n");
  else if (original?.eol === "lf") out = text.replace(/\r\n/g, "\n");
  const body = Buffer.from(out, "utf8");
  return original?.bom ? Buffer.concat([UTF8_BOM, body]) : body;
}
