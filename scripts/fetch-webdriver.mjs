// Fetches the native WebDriver the desktop tests need (TESTING_STRATEGY.md section 2,
// "Desktop integration"; RN-08). Development and CI only: nothing here ships.
//
//   Windows: msedgedriver matching the installed WebView2 runtime, downloaded from Microsoft
//            into node_modules/.cache/jesutobits-webdriver/<version>/ (it must match the
//            WebView2 version exactly, so it cannot be pinned with a hash like the sidecars).
//   Linux:   WebKitWebDriver from the distribution (apt: webkit2gtk-driver); only checked.
//
//   node scripts/fetch-webdriver.mjs      prints the driver's path
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, "node_modules", ".cache", "jesutobits-webdriver");

/** The WebView2 runtime version, from the registry (machine-wide, then per user). */
function webview2Version() {
  if (process.env.JESUTOBITS_WEBVIEW2_VERSION) return process.env.JESUTOBITS_WEBVIEW2_VERSION;
  const key = "Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  for (const hive of [`HKLM\\SOFTWARE\\WOW6432Node\\${key}`, `HKCU\\SOFTWARE\\${key}`]) {
    try {
      const out = execFileSync("reg", ["query", hive, "/v", "pv"], { encoding: "utf8" });
      const version = /pv\s+REG_SZ\s+([\d.]+)/.exec(out)?.[1];
      if (version && version !== "0.0.0.0") return version;
    } catch {
      // Not installed for this hive; try the next.
    }
  }
  throw new Error("WebView2 runtime not found; install the Evergreen runtime");
}

export async function fetchWebDriver() {
  if (process.platform === "linux") {
    try {
      return execFileSync("which", ["WebKitWebDriver"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("WebKitWebDriver not found; install webkit2gtk-driver");
    }
  }
  if (process.platform !== "win32")
    throw new Error("Desktop tests run on Windows and Linux (RN-08)");

  const version = webview2Version();
  const folder = join(cache, version);
  const driver = join(folder, "msedgedriver.exe");
  if (existsSync(driver)) return driver;

  mkdirSync(folder, { recursive: true });
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  const zip = join(folder, "edgedriver_win64.zip");
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${folder}' -Force`,
    ],
    { stdio: "inherit" },
  );
  if (!existsSync(driver)) throw new Error(`msedgedriver.exe missing from ${url}`);
  return driver;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.stdout.write(`${await fetchWebDriver()}\n`);
