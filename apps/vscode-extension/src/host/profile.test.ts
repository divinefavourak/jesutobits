import { describe, expect, it } from "vitest";
import { displayName, isPictureDataUrl, MAX_PICTURE_BYTES, pictureDataUrl } from "./profile.js";

describe("the profile picture", () => {
  it("becomes a data URL of the right image type", () => {
    const result = pictureDataUrl("Me.JPG", new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ url: "data:image/jpeg;base64,AQID" });
    expect("url" in result && isPictureDataUrl(result.url)).toBe(true);
  });

  it("refuses other files, empty files and files over 1 MB", () => {
    expect(pictureDataUrl("me.svg", new Uint8Array([1]))).toHaveProperty("problem");
    expect(pictureDataUrl("me.exe", new Uint8Array([1]))).toHaveProperty("problem");
    expect(pictureDataUrl("me.png", new Uint8Array())).toHaveProperty("problem");
    expect(pictureDataUrl("me.png", new Uint8Array(MAX_PICTURE_BYTES + 1))).toHaveProperty(
      "problem",
    );
  });

  it("only ever shows image data URLs", () => {
    expect(isPictureDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isPictureDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isPictureDataUrl("https://example.com/me.png")).toBe(false);
    expect(isPictureDataUrl('data:image/png;base64,AA"><script>')).toBe(false);
    expect(isPictureDataUrl(undefined)).toBe(false);
  });
});

describe("the display name", () => {
  it("prefers the name the user gave, then the computer's user name", () => {
    expect(displayName("  Ada  ", "homepc")).toBe("Ada");
    expect(displayName("", "homepc")).toBe("Homepc");
    expect(displayName(undefined, "")).toBe("You");
    expect(displayName("x".repeat(80), "a")).toHaveLength(60);
  });
});
