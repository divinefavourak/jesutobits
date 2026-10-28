import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authUrl, SignInCancelled, signInWithOpenRouter } from "./openrouter-auth.js";

/** OpenRouter's side: checks the PKCE pair and mints a key. */
function fakeOpenRouter(challengeOf: () => string, key = "sk-or-v1-test") {
  const calls: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push({ url: String(url), ...body });
    const challenge = createHash("sha256")
      .update(body.code_verifier ?? "")
      .digest("base64url");
    const ok = body.code === "the-code" && challenge === challengeOf();
    return new Response(JSON.stringify(ok ? { key } : { error: "bad" }), {
      status: ok ? 200 : 403,
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** The user's browser: follows OpenRouter's redirect back to the loopback callback. */
function browser(params: (sent: URL) => Record<string, string>) {
  let sent: URL | undefined;
  return {
    open: async (url: string) => {
      sent = new URL(url);
      const callback = new URL(sent.searchParams.get("callback_url") ?? "");
      for (const [name, value] of Object.entries(params(sent))) {
        callback.searchParams.set(name, value);
      }
      // 127.0.0.1 is what `localhost` resolves to when IPv6 is off.
      callback.hostname = "127.0.0.1";
      const page = await fetch(callback);
      return page;
    },
    sent: () => sent,
  };
}

describe("Sign in with OpenRouter", () => {
  it("builds the authorisation URL with S256 PKCE and a state", () => {
    const url = new URL(authUrl("http://localhost:5000/callback", "abc", "xyz"));
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "http://localhost:5000/callback",
      code_challenge: "abc",
      code_challenge_method: "S256",
      state: "xyz",
      key_label: "Jesutobits",
    });
  });

  it("returns the key OpenRouter mints for the code and verifier", async () => {
    const page = browser((sent) => ({
      code: "the-code",
      state: sent.searchParams.get("state") ?? "",
    }));
    const openRouter = fakeOpenRouter(() => page.sent()?.searchParams.get("code_challenge") ?? "");
    const key = await signInWithOpenRouter({
      openBrowser: async (url) => {
        const response = await page.open(url);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Jesutobits is connected");
      },
      fetch: openRouter.fetchFn,
      signal: new AbortController().signal,
    });
    expect(key).toBe("sk-or-v1-test");
    expect(openRouter.calls).toEqual([
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/auth/keys",
        code: "the-code",
        code_challenge_method: "S256",
      }),
    ]);
    expect(page.sent()?.searchParams.get("callback_url")).toMatch(
      /^http:\/\/localhost:\d+\/callback$/,
    );
  });

  it("refuses a callback with someone else's state and keeps waiting", async () => {
    const controller = new AbortController();
    const page = browser(() => ({ code: "the-code", state: "forged" }));
    const signIn = signInWithOpenRouter({
      openBrowser: async (url) => {
        const response = await page.open(url);
        expect(response.status).toBe(400);
        controller.abort();
      },
      fetch: fakeOpenRouter(() => "").fetchFn,
      signal: controller.signal,
    });
    await expect(signIn).rejects.toBeInstanceOf(SignInCancelled);
  });

  it("treats a redirect without a code as the user saying no", async () => {
    const page = browser((sent) => ({ state: sent.searchParams.get("state") ?? "" }));
    const signIn = signInWithOpenRouter({
      openBrowser: async (url) => void (await page.open(url)),
      fetch: fakeOpenRouter(() => "").fetchFn,
      signal: new AbortController().signal,
    });
    await expect(signIn).rejects.toBeInstanceOf(SignInCancelled);
  });

  it("gives up after the timeout", async () => {
    const signIn = signInWithOpenRouter({
      openBrowser: async () => undefined,
      fetch: fakeOpenRouter(() => "").fetchFn,
      signal: new AbortController().signal,
      timeoutMs: 50,
    });
    await expect(signIn).rejects.toThrow("took too long");
  });

  it("reports a refused exchange without the key or the code", async () => {
    const page = browser((sent) => ({
      code: "stale-code",
      state: sent.searchParams.get("state") ?? "",
    }));
    const signIn = signInWithOpenRouter({
      openBrowser: async (url) => void (await page.open(url)),
      fetch: fakeOpenRouter(() => "").fetchFn,
      signal: new AbortController().signal,
    });
    await expect(signIn).rejects.toThrow(/did not accept the sign-in/);
    await expect(signIn).rejects.not.toThrow(/stale-code/);
  });
});
