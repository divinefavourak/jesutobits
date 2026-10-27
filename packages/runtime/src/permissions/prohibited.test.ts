import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prohibitedReason, type ProhibitedPlaces } from "./prohibited.js";

/**
 * Fake folders built with `node:path`; none of them need to exist because the check is
 * purely lexical (SECURITY.md section 4.3).
 */
const TEMP = tmpdir();
const HOME = join(TEMP, "home-x");
const DATA_DIR = join(TEMP, "data-dir");
const CONFIG_DIR = join(TEMP, "config-dir");

const PLACES: ProhibitedPlaces = { appDirs: [DATA_DIR, CONFIG_DIR], home: HOME };

describe("prohibitedReason", () => {
  it("protects Jesutobits' own data", () => {
    expect(prohibitedReason(join(DATA_DIR, "jesutobits.db"), PLACES)).toMatch(
      /Jesutobits' own data/,
    );
    expect(prohibitedReason(DATA_DIR, PLACES)).toMatch(/Jesutobits' own data/);
    expect(prohibitedReason(join(CONFIG_DIR, "deep", "leaf.log"), PLACES)).toMatch(
      /Jesutobits' own data/,
    );
  });

  it("leaves a sibling folder that shares only a prefix alone", () => {
    expect(prohibitedReason(join(TEMP, "data-dir-other", "file.txt"), PLACES)).toBeUndefined();
  });

  it("protects credentials and cloud CLI folders under home", () => {
    expect(prohibitedReason(join(HOME, ".ssh", "id_rsa"), PLACES)).toMatch(/SSH keys/);
    expect(prohibitedReason(join(HOME, ".aws", "credentials"), PLACES)).toMatch(/AWS credentials/);
    expect(prohibitedReason(join(HOME, ".config", "gcloud", "x"), PLACES)).toMatch(
      /Google Cloud credentials/,
    );
  });

  it("protects browser profiles", () => {
    expect(
      prohibitedReason(
        join(HOME, "AppData", "Local", "Google", "Chrome", "User Data", "Default", "Login Data"),
        PLACES,
      ),
    ).toMatch(/a browser profile/);
  });

  it("allows ordinary project paths and home itself", () => {
    expect(prohibitedReason(join(HOME, "projects", "app", "src", "a.ts"), PLACES)).toBeUndefined();
    expect(prohibitedReason(HOME, PLACES)).toBeUndefined();
  });

  it("never allows password databases, wherever they sit", () => {
    expect(prohibitedReason(join(TEMP, "vault.kdbx"), PLACES)).toMatch(/password manager data/);
    expect(prohibitedReason(join(HOME, "Vault.KDBX"), PLACES)).toMatch(/password manager data/);
  });

  it.skipIf(process.platform !== "win32")(
    "still prohibits an app dir spelled with a different case on Windows",
    () => {
      expect(prohibitedReason(DATA_DIR.toUpperCase(), { appDirs: [DATA_DIR], home: HOME })).toMatch(
        /Jesutobits' own data/,
      );
    },
  );
});
