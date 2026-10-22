// The dependency rules from PROJECT_STRUCTURE.md section 3, as data for
// `jesutobits/import-boundaries`. Change this file and that document together.
import { builtinModules } from "node:module";

/** Matches any `@jesutobits/*` package except those listed. */
const jesutobitsExcept = (...allowed) =>
  allowed.length === 0 ? "^@jesutobits/" : `^@jesutobits/(?!(?:${allowed.join("|")})(?:/|$))`;

const bareBuiltins = builtinModules
  .filter((name) => !name.startsWith("_"))
  .map((name) => name.replace("/", "\\/"));
const NODE_BUILTINS = `^(?:node:.*|(?:${bareBuiltins.join("|")})(?:/.*)?)$`;
const FS = "^(?:node:)?fs(?:/promises)?$";

export const boundaryRules = [
  // 3.1 Between packages
  {
    files: ["packages/protocol/"],
    imports: [jesutobitsExcept()],
    message: "protocol depends only on zod",
  },
  {
    files: ["packages/shared/"],
    imports: [jesutobitsExcept(), NODE_BUILTINS],
    message: "shared is pure: no Jesutobits packages and no Node APIs",
  },
  {
    files: ["packages/services/"],
    imports: [jesutobitsExcept("protocol", "shared")],
    message: "services may depend only on protocol and shared",
  },
  {
    files: ["packages/runtime/"],
    imports: [jesutobitsExcept("protocol", "shared", "services", "extension-schema")],
    message: "runtime may depend only on protocol, shared, services and extension-schema",
  },
  {
    files: ["apps/desktop/src/"],
    imports: [
      jesutobitsExcept("protocol", "shared", "extension-schema", "builtin-themes"),
      NODE_BUILTINS,
    ],
    message:
      "The Workbench may depend only on protocol, shared, extension-schema and the built-in themes' data, and never on Node APIs",
  },
  {
    files: ["packages/extension-schema/"],
    imports: [jesutobitsExcept("shared")],
    message: "extension-schema may depend only on shared",
  },
  {
    files: ["packages/extension-cli/"],
    imports: [jesutobitsExcept("extension-schema")],
    message: "extension-cli may depend only on extension-schema",
  },
  {
    files: ["packages/preview-launcher/", "packages/vite-plugin/", "packages/visual-bridge/"],
    imports: [jesutobitsExcept("protocol")],
    message:
      "Guest packages run in user projects and may not depend on Jesutobits packages (ADR-0013)",
  },
  {
    files: ["packages/preview-launcher/", "packages/vite-plugin/", "packages/visual-bridge/"],
    imports: ["^@jesutobits/protocol(?:/|$)"],
    allowTypeOnly: true,
    message: "Guest packages may import protocol as types only (ADR-0013)",
  },

  // 3.2 Inside packages
  {
    files: [""],
    except: ["apps/desktop/src/host-bridge/"],
    imports: ["^@tauri-apps/"],
    message: "Only apps/desktop/src/host-bridge/ may import Tauri (ADR-0001)",
  },
  {
    files: [""],
    except: ["apps/desktop/src/features/editor/"],
    imports: ["^monaco-editor(?:/|$)", "^@monaco-editor/"],
    message: "Only features/editor/ may import Monaco (ADR-0004)",
  },
  {
    files: [""],
    except: ["apps/desktop/src/features/companion/renderers/"],
    imports: ["^@lottiefiles/", "^lottie-web(?:/|$)", "^@rive-app/"],
    message: "Only features/companion/renderers/ may import animation libraries (ADR-0006)",
  },
  {
    files: ["packages/services/src/"],
    // environment.ts only checks PATH folders for executables, never project files.
    except: ["packages/services/src/workspace/", "packages/services/src/process/environment.ts"],
    tests: false,
    imports: [FS],
    message:
      "In services, only workspace/ may use node:fs (WorkspaceService is the single file gateway)",
  },
  {
    files: ["packages/runtime/src/"],
    // cassette-file.ts reads only the development cassette named by JESUTOBITS_CASSETTE.
    except: [
      "packages/runtime/src/storage/",
      "packages/runtime/src/log/",
      "packages/runtime/src/providers/scripted/cassette-file.ts",
    ],
    tests: false,
    imports: [FS],
    message:
      "Project files go through WorkspaceService; in runtime only storage/ and log/ use node:fs",
  },
  {
    files: ["packages/services/src/", "packages/runtime/src/"],
    except: ["packages/services/src/process/"],
    tests: false,
    imports: ["^(?:node:)?child_process$"],
    message:
      "Processes go through ProcessSupervisor; only services/src/process/ uses child_process",
  },
  {
    files: ["packages/", "apps/"],
    except: ["packages/runtime/src/storage/"],
    imports: ["^node:sqlite$"],
    message: "Only runtime/src/storage/ may use node:sqlite",
  },
  {
    files: ["packages/runtime/src/"],
    except: ["packages/runtime/src/providers/"],
    tests: false,
    imports: ["^(?:node:)?(?:http|https|http2|net|tls|dgram)$", "^undici(?:/|$)"],
    message: "Only runtime/src/providers/ performs network requests (NFR-015)",
  },
  {
    files: ["packages/runtime/", "packages/services/"],
    imports: ["\\.node$"],
    message: "Native addons are banned in runtime and services (ADR-0002)",
  },
];

export const isolatedFolders = [
  {
    dir: "packages/runtime/src/tools/",
    shared: ["common"],
    message: "Tools never import other tools; move shared logic to tools/common or services",
  },
];
