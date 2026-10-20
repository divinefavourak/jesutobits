import { describe, expect, it } from "vitest";
import { decodeText, detectLineEndings, encodeText } from "./text.js";

const BOM = [0xef, 0xbb, 0xbf];

describe("decodeText", () => {
  it("reads UTF-8 with its BOM and line endings", () => {
    const decoded = decodeText(Buffer.from([...BOM, ...Buffer.from("a\r\nb\r\n")]));
    expect(decoded).toEqual({
      binary: false,
      text: "a\r\nb\r\n",
      format: { bom: true, eol: "crlf" },
    });
  });

  it("treats NUL bytes, invalid UTF-8 and UTF-16 as binary", () => {
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toEqual({ binary: true });
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toEqual({ binary: true });
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ binary: true });
  });

  it("reads an empty file as text", () => {
    expect(decodeText(Buffer.alloc(0))).toEqual({
      binary: false,
      text: "",
      format: { bom: false, eol: "none" },
    });
  });
});

describe("detectLineEndings", () => {
  it.each([
    ["a\nb\n", "lf"],
    ["a\r\nb\r\n", "crlf"],
    ["a\r\nb\n", "mixed"],
    ["one line", "none"],
  ] as const)("%j is %s", (text, eol) => expect(detectLineEndings(text)).toBe(eol));
});

describe("encodeText", () => {
  it("keeps a CRLF file CRLF when the new text uses LF", () => {
    expect(encodeText("a\nb\n", { bom: false, eol: "crlf" }).toString()).toBe("a\r\nb\r\n");
  });

  it("keeps an LF file LF when the new text uses CRLF", () => {
    expect(encodeText("a\r\nb", { bom: false, eol: "lf" }).toString()).toBe("a\nb");
  });

  it("leaves mixed and new files exactly as given", () => {
    expect(encodeText("a\r\nb\n", { bom: false, eol: "mixed" }).toString()).toBe("a\r\nb\n");
    expect(encodeText("a\r\nb\n", undefined).toString()).toBe("a\r\nb\n");
  });

  it("keeps the BOM", () => {
    expect([...encodeText("x", { bom: true, eol: "none" })]).toEqual([...BOM, 0x78]);
  });

  it("round-trips a CRLF file with a BOM byte for byte", () => {
    const original = Buffer.from([...BOM, ...Buffer.from("const a = 1;\r\nconst b = 2;\r\n")]);
    const decoded = decodeText(original);
    if (decoded.binary) throw new Error("expected text");
    expect(encodeText(decoded.text, decoded.format).equals(original)).toBe(true);
  });
});
