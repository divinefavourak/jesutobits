// Generates the `large-tree` fixture (TESTING_STRATEGY.md section 3.3): a project with
// --files source files (default 100,000) for NFR-019, plus a node_modules folder that must
// never be walked. Deterministic: the same arguments give the same tree.
//
//   node scripts/gen-large-tree.mjs <dir> [--files 100000]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Generates the tree; returns the number of source files written. */
export function generateLargeTree(dir, files = 100_000) {
  const perFolder = 50;
  const foldersPerLevel = 20;
  let written = 0;
  for (let folder = 0; written < files; folder++) {
    // Three levels deep: pkg-N/module-N/part-N.
    const a = Math.floor(folder / (foldersPerLevel * foldersPerLevel));
    const b = Math.floor(folder / foldersPerLevel) % foldersPerLevel;
    const c = folder % foldersPerLevel;
    const path = join(dir, "src", `pkg-${a}`, `module-${b}`, `part-${c}`);
    mkdirSync(path, { recursive: true });
    for (let n = 0; n < perFolder && written < files; n++, written++) {
      writeFileSync(join(path, `file-${n}.ts`), `export const value${written} = ${written};\n`);
    }
  }
  // Ignored dependencies: large, and never walked by the index.
  for (let n = 0; n < 200; n++) {
    const path = join(dir, "node_modules", `dep-${n}`);
    mkdirSync(path, { recursive: true });
    for (let m = 0; m < 50; m++)
      writeFileSync(join(path, `index-${m}.js`), "module.exports = 0;\n");
  }
  writeFileSync(join(dir, "package.json"), '{ "name": "large-tree", "private": true }\n');
  return written;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/").replace(/^\/?/, "/")}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: node scripts/gen-large-tree.mjs <dir> [--files N]");
  const index = process.argv.indexOf("--files");
  const files = index === -1 ? 100_000 : Number(process.argv[index + 1]);
  const started = performance.now();
  const written = generateLargeTree(dir, files);
  process.stdout.write(`${written} files in ${Math.round(performance.now() - started)} ms\n`);
}
