// Spike S2: visual edit feasibility in a plain browser (ROADMAP Phase 0, ADR-0009).
//
// 1. Starts fixtures/projects/vite-react-tailwind through the preview launcher, with the
//    Jesutobits plugin added inline. The project's vite.config must stay untouched and its
//    own plugins must still run (RN-24).
// 2. Opens the page in a headless Chromium-family browser (system Edge, ADR-0010).
// 3. Samples 20 instrumented elements. For each: the attribute must point at the exact
//    `<tag` in the source file, and a click at the element's centre must resolve (nearest
//    instrumented ancestor) to a location that also points at the right tag.
// 4. Applies one Tailwind class change with the SourceTransformer and measures the time
//    from the file write to HMR (`vite:afterUpdate`) and to the change in the DOM. React
//    state must survive (an HMR update, not a reload).
// 5. Restores the file.
//
//   node scripts/spikes/s2-run.mjs
// Needs: `pnpm build:packages`, `pnpm install` in the fixture, and Microsoft Edge.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = join(root, "fixtures", "projects", "vite-react-tailwind");
const launcher = join(root, "packages", "preview-launcher", "dist", "preview-launcher.js");
const plugin = join(root, "packages", "vite-plugin", "dist", "bundle", "index.mjs");
const { applyClassEdit } = await import(
  pathToFileURL(join(root, "packages", "services", "dist", "index.js")).href
);
const { instrumentJsx } = await import(pathToFileURL(plugin).href);

const PORT = 5897;
const SAMPLES = 20;
const HMR_BUDGET_MS = 1000;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceLines = new Map();
const lines = (file) => {
  if (!sourceLines.has(file)) {
    sourceLines.set(file, readFileSync(join(fixture, file), "utf8").split(/\r?\n/));
  }
  return sourceLines.get(file);
};

/** True when `file:line:column` points at `<tag` followed by a delimiter or the line end. */
function locPointsAt(loc, tag) {
  const match = /^(.+):(\d+):(\d+)$/.exec(loc ?? "");
  if (!match) return false;
  const line = lines(match[1])[Number(match[2]) - 1] ?? "";
  // Multi-line opening tags (`<button` then attributes on the next lines) end the line.
  return new RegExp(`^<${tag}(?:[\\s/>]|$)`).test(line.slice(Number(match[3]) - 1));
}

const configHash = sha256(join(fixture, "vite.config.ts"));
const checks = {};
const record = (name, ok, detail) => {
  checks[name] = { ok: Boolean(ok), ...(detail !== undefined && { detail }) };
};

// 1. Start the project's own Vite through the launcher, with the plugin inline.
const server = spawn(
  process.execPath,
  [launcher, "--root", fixture, "--port", String(PORT), "--plugin", plugin],
  { cwd: fixture, stdio: ["pipe", "pipe", "inherit"] },
);
const events = [];
let stdout = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("@@jesutobits ")) events.push(JSON.parse(line.slice(13)));
  }
});
const started = performance.now();
const ready = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const event = events.find((e) => e.event === "ready" || e.event === "error");
    if (event) {
      clearInterval(timer);
      return event.event === "ready" ? resolve(event) : reject(new Error(JSON.stringify(event)));
    }
    if (performance.now() - started > 60_000) {
      clearInterval(timer);
      reject(new Error(`Launcher not ready within 60 s:\n${stdout}`));
    }
  }, 50);
});
const startMs = Math.round(performance.now() - started);
const plugins = events.find((e) => e.event === "plugins")?.names ?? [];
const ours = plugins.indexOf("jesutobits:visual-edit");
const reactPlugin = plugins.findIndex((name) => name.startsWith("vite:react"));
// Inline plugins come after the config file's (RN-24); position is recorded, not asserted.
// What matters is that JSX reaches our transform uncompiled, checked once the page loads.
record(
  "project plugins and ours both active (RN-24)",
  ours !== -1 && reactPlugin !== -1 && plugins.some((n) => n.includes("tailwind")),
  { ours, firstReactPlugin: reactPlugin, order: plugins },
);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const transformMs = {};
try {
  await page.goto(ready.url);
  await page.waitForSelector("[data-testid=counter]");
  record(
    "bridge injected by transformIndexHtml",
    await page.evaluate(() => window.__jesutobits?.version === "s2-stub"),
  );

  // 3. Sample instrumented elements and verify locations, directly and by clicking.
  const all = await page.$$eval("[data-jesutobits-loc]", (nodes) =>
    nodes.map((node, index) => ({
      index,
      tag: node.tagName.toLowerCase(),
      loc: node.getAttribute("data-jesutobits-loc"),
    })),
  );
  record(
    "JSX reached our transform before compilation (instrumented elements in the DOM)",
    all.length >= SAMPLES,
    { instrumented: all.length },
  );
  const step = all.length / SAMPLES;
  const sample = Array.from(
    { length: Math.min(SAMPLES, all.length) },
    (_, i) => all[Math.floor(i * step)],
  );
  const results = [];
  for (const element of sample) {
    const handle = (await page.$$("[data-jesutobits-loc]"))[element.index];
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    // What a click at the centre selects: the deepest node there, then its nearest instrumented ancestor.
    const clicked = box
      ? await page.evaluate(
          ([x, y]) => window.__jesutobits.resolve(document.elementFromPoint(x, y)),
          [box.x + box.width / 2, box.y + box.height / 2],
        )
      : null;
    results.push({
      ...element,
      attributeOk: locPointsAt(element.loc, element.tag),
      clicked: clicked?.loc ?? null,
      clickOk: clicked ? locPointsAt(clicked.loc, clicked.tag) : !box,
    });
  }
  const bad = results.filter((r) => !r.attributeOk || !r.clickOk);
  record(
    `${sample.length} of ${all.length} sampled elements resolve to the exact file:line:column`,
    sample.length === SAMPLES && bad.length === 0,
    bad.length ? bad : undefined,
  );
  record(
    "component roots carry data-jesutobits-comp",
    await page.evaluate(() =>
      ["App", "Hero", "Button", "FeatureList", "Counter", "Footer"].every((name) =>
        document.querySelector(`[data-jesutobits-comp="${name}"]`),
      ),
    ),
  );
  record(
    "text inside <Button> resolves to Button.tsx",
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Get started",
      );
      return window.__jesutobits
        .resolve(button.firstChild?.parentElement)
        ?.loc.startsWith("src/components/Button.tsx:");
    }),
  );
  record(
    "CRLF file (Counter.tsx) resolves exactly",
    results.some((r) => r.loc.startsWith("src/components/Counter.tsx")) &&
      results
        .filter((r) => r.loc.startsWith("src/components/Counter.tsx"))
        .every((r) => r.attributeOk),
  );

  // 4. One Tailwind class edit through the SourceTransformer, then HMR.
  await page.click("text=Add one");
  await page.click("text=Add one");
  const countBefore = await page.textContent("[data-testid=count]");
  await page.evaluate(() => (window.__notReloaded = true));
  const heroFile = join(fixture, "src", "components", "Hero.tsx");
  const original = readFileSync(heroFile, "utf8");
  const h1Loc = await page.getAttribute("h1", "data-jesutobits-loc");
  const [, line, column] = /:(\d+):(\d+)$/.exec(h1Loc);
  const fontBefore = await page.$eval("h1", (h1) => getComputedStyle(h1).fontSize);
  const edited = applyClassEdit(original, {
    typescript: true,
    loc: { line: Number(line), column: Number(column) },
    edit: { remove: ["text-4xl"], add: ["text-6xl"] },
  });
  const changed = edited.code.split("\n").filter((l, i) => l !== original.split("\n")[i]);
  record("edit changes exactly one line", changed.length === 1, changed);

  try {
    const updatesBefore = await page.evaluate(() => window.__jesutobits.hmrUpdates.length);
    const writtenAt = Date.now();
    writeFileSync(heroFile, edited.code);
    await page.waitForFunction(
      (before) => getComputedStyle(document.querySelector("h1")).fontSize !== before,
      fontBefore,
      { polling: "raf", timeout: 10_000 },
    );
    const domMs = Date.now() - writtenAt;
    const update = await page.evaluate((n) => window.__jesutobits.hmrUpdates[n], updatesBefore);
    const hmrMs = update ? update.at - writtenAt : undefined;
    const fontAfter = await page.$eval("h1", (h1) => getComputedStyle(h1).fontSize);
    record(`class edit visible via HMR within ${HMR_BUDGET_MS} ms`, domMs < HMR_BUDGET_MS, {
      writeToAfterUpdateMs: hmrMs,
      writeToDomMs: domMs,
      fontBefore,
      fontAfter,
    });
    record(
      "HMR, not a reload: page and React state kept",
      (await page.evaluate(() => window.__notReloaded === true)) &&
        (await page.textContent("[data-testid=count]")) === countBefore,
      { count: countBefore },
    );
    record(
      "selection survives: same loc after the edit",
      (await page.getAttribute("h1", "data-jesutobits-loc")) === h1Loc,
    );
  } finally {
    writeFileSync(heroFile, original); // 5. Restore.
  }

  // Instrumentation cost per file (budget 5 ms, VISUAL_EDITING.md section 6.1).
  for (const file of [
    "src/App.tsx",
    "src/components/Hero.tsx",
    "src/components/FeatureList.tsx",
    "src/components/Counter.tsx",
    "src/components/Footer.tsx",
    "src/components/Button.tsx",
  ]) {
    const code = readFileSync(join(fixture, file), "utf8");
    for (let i = 0; i < 20; i++) instrumentJsx(code, file, true); // warm up
    const t = performance.now();
    for (let i = 0; i < 200; i++) instrumentJsx(code, file, true);
    transformMs[file] = Number(((performance.now() - t) / 200).toFixed(3));
  }
  record(
    "instrumentation under 5 ms per file",
    Object.values(transformMs).every((ms) => ms < 5),
    transformMs,
  );
} finally {
  await browser.close();
  server.stdin.end();
  await new Promise((resolve) => server.on("exit", resolve));
}
record("vite.config.ts untouched", sha256(join(fixture, "vite.config.ts")) === configHash);

process.stdout.write(
  `\nSpike S2: Vite ${events.find((e) => e.event === "plugins")?.vite}, server ready in ${startMs} ms\n`,
);
for (const [name, { ok }] of Object.entries(checks))
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}\n`);
process.stdout.write(
  `\nDetails: ${JSON.stringify(
    Object.fromEntries(
      Object.entries(checks)
        .filter(([, c]) => c.detail !== undefined)
        .map(([n, c]) => [n, c.detail]),
    ),
    null,
    2,
  )}\n`,
);
process.exit(Object.values(checks).every((c) => c.ok) ? 0 : 1);
