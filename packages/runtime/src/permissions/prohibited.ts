import path from "node:path";

/**
 * Places agent tools may never touch, inside a project or not (SECURITY.md section 4.3):
 * Jesutobits' own data, settings and logs (which hold the database and checkpoints), SSH
 * and cloud CLI credentials, browser profiles and password-manager data. They matter when
 * a project contains them, for example when the user opens their home folder as a project.
 */
export interface ProhibitedPlaces {
  /** Jesutobits' data dir and the Host's config and log dirs (`runtime.configure`). */
  appDirs: readonly string[];
  home: string | undefined;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** Under home: credentials, browser profiles, password managers. */
const HOME_PLACES: ReadonlyArray<readonly [string, string]> = [
  [".ssh", "SSH keys"],
  [".aws", "AWS credentials"],
  [".azure", "Azure credentials"],
  [".config/gcloud", "Google Cloud credentials"],
  [".kube", "Kubernetes credentials"],
  [".docker", "Docker credentials"],
  [".gnupg", "GPG keys"],
  [".mozilla", "a browser profile"],
  [".config/google-chrome", "a browser profile"],
  [".config/chromium", "a browser profile"],
  [".config/BraveSoftware", "a browser profile"],
  ["AppData/Local/Google/Chrome/User Data", "a browser profile"],
  ["AppData/Local/Microsoft/Edge/User Data", "a browser profile"],
  ["AppData/Local/BraveSoftware", "a browser profile"],
  ["AppData/Roaming/Mozilla/Firefox", "a browser profile"],
  ["Library/Application Support/Google/Chrome", "a browser profile"],
  ["Library/Application Support/Firefox", "a browser profile"],
  ["Library/Safari", "a browser profile"],
  ["Library/Keychains", "the macOS keychain"],
  ["AppData/Roaming/Bitwarden", "password manager data"],
  ["AppData/Local/1Password", "password manager data"],
  ["AppData/Roaming/KeePass", "password manager data"],
  [".config/Bitwarden", "password manager data"],
  [".config/1Password", "password manager data"],
];

/** Password databases, wherever they are. */
const PROHIBITED_FILES = /\.(?:kdbx|kdb|keychain|keychain-db|1pif|agilekeychain|opvault)$/i;

function normalise(value: string): string {
  const resolved = path.resolve(value);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(normalise(parent), normalise(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Why `realPath` (links resolved) is never allowed, or undefined when it is not prohibited. */
export function prohibitedReason(realPath: string, places: ProhibitedPlaces): string | undefined {
  for (const dir of places.appDirs) {
    if (within(realPath, dir)) {
      return "Jesutobits' own data, settings and logs can never be read or changed by the agent.";
    }
  }
  if (places.home) {
    for (const [relative, what] of HOME_PLACES) {
      if (within(realPath, path.join(places.home, ...relative.split("/")))) {
        return `This is ${what}; the agent can never read or change it.`;
      }
    }
  }
  if (PROHIBITED_FILES.test(realPath)) {
    return "This is password manager data; the agent can never read or change it.";
  }
  return undefined;
}
