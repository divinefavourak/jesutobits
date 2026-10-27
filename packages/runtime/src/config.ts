import { RuntimeSettingsSchema, type RuntimeSettings } from "@jesutobits/protocol";

/**
 * The settings the runtime acts on (`runtime.configure`). The Host owns settings.json and
 * sends them after every handshake and every change; until then, the defaults apply.
 */
export class RuntimeConfig {
  private current: RuntimeSettings = RuntimeSettingsSchema.parse({});
  private dirs: readonly string[] = [];
  private readonly listeners = new Set<(settings: RuntimeSettings) => void>();

  get settings(): RuntimeSettings {
    return this.current;
  }

  /** Jesutobits' own folders besides the data dir; agent tools may never touch them. */
  get appDirs(): readonly string[] {
    return this.dirs;
  }

  /** `params` was validated against `runtime.configure`'s schema by the RPC server. */
  update(params: { settings: RuntimeSettings; appDirs: readonly string[] }): void {
    this.current = params.settings;
    this.dirs = [...params.appDirs];
    for (const listener of this.listeners) listener(this.current);
  }

  onChange(listener: (settings: RuntimeSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
