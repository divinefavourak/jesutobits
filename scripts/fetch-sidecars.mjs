// Fetches the pinned sidecar binaries (Node for the runtime, ripgrep for search) for the
// Host's target triple, verifies each archive's SHA-256 against scripts/sidecars.json and
// installs them as Tauri sidecars (ADR-0002, RN-02):
//   apps/desktop/src-tauri/binaries/<binaryName>-<triple>[.exe]
// Archives are cached in node_modules/.cache/jesutobits-sidecars/. Refuses to continue on a
// hash mismatch. Usage: node scripts/fetch-sidecars.mjs [--target <triple>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { $comment: _comment, ...sidecars } = JSON.parse(
  await readFile(join(root, "scripts", "sidecars.json"), "utf8"),
);

function hostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = /^host: (.+)$/m.exec(out)?.[1];
    if (host) return host.trim();
  } catch {
    // Fall through to the Node platform mapping when Rust is not installed.
  }
  const map = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  return map[`${process.platform}-${process.arch}`];
}

const targetFlag = process.argv.indexOf("--target");
const triple = targetFlag === -1 ? hostTriple() : process.argv[targetFlag + 1];
const exe = triple.includes("windows") ? ".exe" : "";
const binDir = join(root, "apps", "desktop", "src-tauri", "binaries");
const cacheDir = join(root, "node_modules", ".cache", "jesutobits-sidecars");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

// bsdtar (Windows 10+, macOS) reads zip and tar; GNU tar on Linux reads .tar.xz and .tar.gz.
// On Windows, name System32's bsdtar explicitly: Git Bash puts a GNU tar first on PATH,
// which cannot read zip files and treats "C:" as a remote host.
const tar =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

async function install(name, manifest) {
  const target = manifest.targets[triple];
  if (!target) {
    throw new Error(
      `No pinned ${name} binary for target ${triple}. Add it to scripts/sidecars.json.`,
    );
  }
  const dest = join(binDir, `${manifest.binaryName}-${triple}${exe}`);
  const stamp = `${dest}.sha256`;

  // Up to date when the stamp records this archive hash.
  if (
    (await exists(dest)) &&
    (await readFile(stamp, "utf8").catch(() => "")).trim() === target.sha256
  ) {
    process.stdout.write(`${name} ${manifest.version} sidecar for ${triple} is up to date.\n`);
    return;
  }

  const archive = join(cacheDir, basename(new URL(target.url).pathname));
  await mkdir(cacheDir, { recursive: true });
  let bytes = (await exists(archive)) ? await readFile(archive) : undefined;
  if (!bytes || sha256(bytes) !== target.sha256) {
    process.stdout.write(`Downloading ${target.url}\n`);
    const response = await fetch(target.url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${target.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== target.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${target.url}: expected ${target.sha256}, got ${actual}`,
      );
    }
    await writeFile(archive, bytes);
  }

  const work = await mkdtemp(join(tmpdir(), `jesutobits-${name}-`));
  try {
    execFileSync(tar, ["-xf", archive, "-C", work, target.member], { stdio: "inherit" });
    await mkdir(binDir, { recursive: true });
    await copyFile(join(work, ...target.member.split("/")), dest);
    if (!exe) await chmod(dest, 0o755);
    await writeFile(stamp, `${target.sha256}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  process.stdout.write(`Installed ${name} ${manifest.version} sidecar: ${dest}\n`);
}

for (const [name, manifest] of Object.entries(sidecars)) await install(name, manifest);
