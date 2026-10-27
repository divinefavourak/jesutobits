import type { SecretRef } from "@jesutobits/protocol";
import type { SecretRegistry } from "../log/secret-registry.js";

/** No key is stored for the provider; the adapter reports it as `auth` / `no_credentials`. */
export class MissingCredentialError extends Error {
  constructor(readonly ref: SecretRef) {
    super("No OpenRouter API key is stored yet. Add your key to start.");
    this.name = "MissingCredentialError";
  }
}

/**
 * The runtime's view of a provider key (AGENT_HARNESS.md section 2.4, SECURITY.md section 3).
 * The key is fetched from the Host's credential store only when a request needs it, kept in
 * memory for the life of the runtime, and registered with the SecretRegistry, so every log
 * line, event and model request that would contain it is masked. After a 401, `invalidate`
 * drops it so the next request fetches it again (the user may have just changed it).
 */
export class CredentialClient {
  private cached: string | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly ref: SecretRef,
    /** `host.secrets.get`: the stored value, or null. */
    private readonly fetchSecret: (ref: SecretRef) => Promise<string | null>,
    private readonly secrets: SecretRegistry,
  ) {}

  get(): Promise<string> {
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    // Concurrent requests (a model call and a model list) share one Host call.
    this.inFlight ??= this.fetchSecret(this.ref)
      .then((value) => {
        if (value === null) throw new MissingCredentialError(this.ref);
        this.secrets.register(this.ref, value);
        this.cached = value;
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  /** Forgets the key; it stays registered for masking, since it may still appear in text. */
  invalidate(): void {
    this.cached = undefined;
  }
}
