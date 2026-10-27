import { get } from "node:http";
import { createServer } from "node:net";

/** A free TCP port on 127.0.0.1, from the OS (the preview binds loopback only). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Resolves once `url` answers HTTP (any status: a 404 page still means the server is up), or
 * rejects after `timeoutMs` or when `signal` aborts. Loopback URLs only.
 */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error(`Not a loopback URL: ${url}`);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (await answers(target)) return;
    if (Date.now() > deadline)
      throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function answers(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}
