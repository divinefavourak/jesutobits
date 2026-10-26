import { describe, expect, it } from "vitest";
import { holdsAuthToken, hideValues, isSecretPatternFile } from "./secret-patterns.js";

describe("isSecretPatternFile", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "config/.env.test",
    "server.pem",
    "private.key",
    "cert.p12",
    "cert.pfx",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "credentials.json",
    "release.keystore",
    ".ENV",
    "ID_RSA",
    "Config/.ENV.LOCAL",
    "CERT.P12",
  ])("recognises %s as a secret file", (name) => {
    expect(isSecretPatternFile(name)).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    "envelope.ts",
    "src/environment.ts",
    "README.md",
    "keys.ts",
    "my.keyboard",
  ])("does not treat %s as a secret file", (name) => {
    expect(isSecretPatternFile(name)).toBe(false);
  });
});

describe(".npmrc and .yarnrc.yml", () => {
  it("counts them as secret while the content is unknown", () => {
    expect(isSecretPatternFile(".npmrc")).toBe(true);
    expect(isSecretPatternFile(".yarnrc.yml")).toBe(true);
  });

  it("counts them as secret only when they hold an auth token", () => {
    expect(isSecretPatternFile(".npmrc", "//registry.npmjs.org/:_authToken=abc")).toBe(true);
    expect(isSecretPatternFile(".npmrc", "_auth = x")).toBe(true);
    expect(isSecretPatternFile(".yarnrc.yml", "npmAuthToken: abc")).toBe(true);
    expect(isSecretPatternFile(".npmrc", "registry=https://registry.npmjs.org/")).toBe(false);
  });

  it("finds each known token spelling", () => {
    expect(holdsAuthToken("_authToken=abc")).toBe(true);
    expect(holdsAuthToken("always-auth=false\n_auth = x")).toBe(true);
    expect(holdsAuthToken("npmAuthToken: abc")).toBe(true);
    expect(holdsAuthToken("registry=https://registry.npmjs.org/")).toBe(false);
  });
});

describe("hideValues", () => {
  it("keeps keys and layout and masks values", () => {
    expect(hideValues("API_KEY=abc\nexport TOKEN = 'x'\n# comment\n\nURL: https://x\n")).toBe(
      "API_KEY=***\nexport TOKEN = ***\n# comment\n\nURL: ***\n",
    );
  });

  it("keeps CRLF line endings", () => {
    expect(hideValues("A=1\r\nB=2\r\n")).toBe("A=***\r\nB=***\r\n");
  });

  it("leaves an empty value empty", () => {
    expect(hideValues("EMPTY=\n")).toBe("EMPTY=\n");
  });

  it("hides a private key block whole", () => {
    expect(
      hideValues(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpg\n-----END RSA PRIVATE KEY-----\nKEY=value\n",
      ),
    ).toBe("***\nKEY=***\n");
  });

  it("keeps section headers and semicolon comments", () => {
    expect(hideValues("[core]\n; comment\nuser = token\n")).toBe("[core]\n; comment\nuser = ***\n");
  });
});
