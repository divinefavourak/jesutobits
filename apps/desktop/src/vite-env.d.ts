/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `relay` runs the Spike S1 relay benchmark as soon as the runtime is ready. */
  readonly VITE_JESUTOBITS_BENCH?: string;
  /** A preview URL for the Spike S3 frame probe; unset in normal builds. */
  readonly VITE_JESUTOBITS_PREVIEW_PROBE?: string;
}
