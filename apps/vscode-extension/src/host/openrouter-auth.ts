// Sign in with OpenRouter (OAuth PKCE, https://openrouter.ai/docs/use-cases/oauth-pkce): the
// user allows Jesutobits on openrouter.ai and OpenRouter makes a key for it, so nobody has to
// create and paste a key by hand. The key is handed to the caller, which keeps it in
// SecretStorage (invariant 3); it is never logged or put in an error message.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const AUTH_URL = "https://openrouter.ai/auth";
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_PATH = "/callback";
/** OpenRouter's code lives 10 minutes; the browser step should take far less. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface SignInOptions {
  /** Opens openrouter.ai in the user's browser. */
  openBrowser(url: string): Promise<void>;
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
}

/** The user closed the flow, the wait timed out, or OpenRouter reported a denial. */
export class SignInCancelled extends Error {}

/** Runs the whole flow and resolves with the new key. */
export async function signInWithOpenRouter(options: SignInOptions): Promise<string> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const callback = await listenForCallback(state, options.signal, options.timeoutMs);
  try {
    await options.openBrowser(authUrl(callback.url, challenge, state));
    const code = await callback.code;
    return await exchangeCode(options.fetch, code, verifier, options.signal);
  } finally {
    callback.close();
  }
}

export function authUrl(callbackUrl: string, challenge: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("key_label", "Jesutobits");
  return url.toString();
}

export async function exchangeCode(
  fetchFn: typeof fetch,
  code: string,
  verifier: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetchFn(KEYS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "OpenRouter did not accept the sign-in (it may have expired). Try again."
        : `OpenRouter could not finish the sign-in (HTTP ${response.status}). Try again.`,
    );
  }
  const body = (await response.json().catch(() => null)) as { key?: unknown } | null;
  if (typeof body?.key !== "string" || body.key.trim() === "") {
    throw new Error("OpenRouter's answer had no key. Try again.");
  }
  return body.key.trim();
}

/**
 * Waits on a loopback port for OpenRouter's redirect. Only `127.0.0.1` and `::1` are bound,
 * never the LAN. A request without our `state` is refused and the wait goes on.
 */
async function listenForCallback(
  state: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ url: string; code: Promise<string>; close(): void }> {
  let settle!: { resolve(code: string): void; reject(error: Error): void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Rejections are awaited by the caller; this keeps an early one from going unhandled.
  code.catch(() => undefined);

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      respond(response, 404, "Not found.");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      respond(response, 400, "This sign-in link did not come from Jesutobits.");
      return;
    }
    const received = url.searchParams.get("code");
    if (!received) {
      respond(response, 400, "OpenRouter did not connect Jesutobits. You can close this tab.");
      settle.reject(new SignInCancelled("OpenRouter did not connect Jesutobits."));
      return;
    }
    respond(response, 200, "Jesutobits is connected. You can close this tab and go back.");
    settle.resolve(received);
  };

  const primary = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    primary.once("error", reject);
    primary.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = primary.address() as AddressInfo;
  // Browsers may try `localhost` as ::1 first; serve it too when the system has IPv6.
  const secondary = createServer(handle);
  secondary.on("error", () => secondary.close());
  secondary.listen(port, "::1");

  const timer = setTimeout(
    () => settle.reject(new SignInCancelled("The sign-in took too long.")),
    timeoutMs,
  );
  const onAbort = () => settle.reject(new SignInCancelled("The sign-in was cancelled."));
  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort, { once: true });

  return {
    url: `http://localhost:${port}${CALLBACK_PATH}`,
    code,
    close: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      primary.close();
      secondary.close();
      primary.closeAllConnections();
      secondary.closeAllConnections();
    },
  };
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html><title>Jesutobits</title>` +
      `<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
      `<p>${message}</p></body>`,
  );
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
