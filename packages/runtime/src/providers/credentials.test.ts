import { describe, expect, it, vi } from "vitest";
import { SecretRegistry } from "../log/secret-registry.js";
import { CredentialClient, MissingCredentialError } from "./credentials.js";

const REF = "provider:openrouter:default";
const VALUE = "sk-or-v1-CANARY-0123456789abcdefghij";
const NEW_VALUE = "sk-or-v1-CANARY-zyxwvutsrqponmlkjihgfedcba";

describe("CredentialClient", () => {
  it("fetches the secret once and caches the value", async () => {
    const secrets = new SecretRegistry();
    const fetchSecret = vi.fn(async () => VALUE);
    const client = new CredentialClient(REF, fetchSecret, secrets);

    expect(await client.get()).toBe(VALUE);
    expect(await client.get()).toBe(VALUE);

    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(fetchSecret).toHaveBeenCalledWith(REF);
  });

  it("shares one fetch between concurrent callers", async () => {
    const secrets = new SecretRegistry();
    let release: ((value: string | null) => void) | undefined;
    const fetchSecret = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const client = new CredentialClient(REF, fetchSecret, secrets);

    const first = client.get();
    const second = client.get();
    expect(fetchSecret).toHaveBeenCalledTimes(1);

    release?.(VALUE);
    expect(await Promise.all([first, second])).toEqual([VALUE, VALUE]);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  it("registers the value with the SecretRegistry for masking", async () => {
    const secrets = new SecretRegistry();
    const client = new CredentialClient(REF, async () => VALUE, secrets);

    await client.get();

    expect(secrets.mask(`key ${VALUE}`)).toBe(`key [REDACTED:${REF}]`);
    expect(secrets.mask(`key ${VALUE}`)).not.toContain(VALUE);
  });

  it("rejects with MissingCredentialError for a missing key and caches nothing", async () => {
    const secrets = new SecretRegistry();
    const fetchSecret = vi.fn(async () => null);
    const client = new CredentialClient(REF, fetchSecret, secrets);

    const first = await client.get().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(MissingCredentialError);
    expect(first).toMatchObject({ name: "MissingCredentialError", ref: REF });
    expect(secrets.mask(`key ${VALUE}`)).not.toContain(`[REDACTED:${REF}]`);

    const second = await client.get().catch((error: unknown) => error);
    expect(second).toBeInstanceOf(MissingCredentialError);
    expect(fetchSecret).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected fetch", async () => {
    const secrets = new SecretRegistry();
    const unavailable = new Error("the Host is not running");
    const fetchSecret = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(VALUE);
    const client = new CredentialClient(REF, fetchSecret, secrets);

    await expect(client.get()).rejects.toBe(unavailable);
    expect(await client.get()).toBe(VALUE);
    expect(fetchSecret).toHaveBeenCalledTimes(2);
  });

  it("fetches again after invalidate and keeps both values masked", async () => {
    const secrets = new SecretRegistry();
    const fetchSecret = vi.fn().mockResolvedValueOnce(VALUE).mockResolvedValueOnce(NEW_VALUE);
    const client = new CredentialClient(REF, fetchSecret, secrets);

    expect(await client.get()).toBe(VALUE);
    client.invalidate();
    expect(await client.get()).toBe(NEW_VALUE);

    expect(fetchSecret).toHaveBeenCalledTimes(2);
    expect(secrets.mask(`new ${NEW_VALUE}`)).toBe(`new [REDACTED:${REF}]`);
    expect(secrets.mask(`old ${VALUE}`)).not.toContain(VALUE);
  });
});
