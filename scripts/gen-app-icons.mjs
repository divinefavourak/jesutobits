// Renders the app icon set for the jesutobits-ide fork (ADR-0015) from the "J" tile that
// gen-logo.mjs draws (docs/assets/jesutobits-icon.svg). Files are written at the paths they
// replace in the VS Code source, so the fork copies the folder over vscode/ as it is:
//
//   resources/win32/code.ico                       16-256 px, PNG entries
//   resources/win32/code_70x70.png, code_150x150.png    Start menu tiles
//   resources/win32/inno-{big,small}-{100..250}.bmp     installer wizard images
//   resources/linux/code.png                       1024 px
//   src/vs/workbench/browser/media/code-icon.svg   title bar and banner
//   src/vs/workbench/browser/parts/editor/media/letterpress-*.svg   empty editor watermark
//
// Rasterising uses the system Edge or Chrome through playwright-core.
//
//   node scripts/gen-app-icons.mjs --out ../jesutobits-ide/branding

// render() runs its callback in the browser page.
/* global document, Image */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { out: { type: "string" } } });
if (!args.out) throw new Error("Pass --out <folder>, for example ../jesutobits-ide/branding");
const out = resolve(args.out);

const ICON = readFileSync(join(root, "docs", "assets", "jesutobits-icon.svg"), "utf8");
/** The tile's own background, so installer art blends with it. */
const TILE = "#0F172A";
const SCALES = [100, 125, 150, 175, 200, 225, 250];

function write(path, data) {
  const file = join(out, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${path}`);
}

/** The J alone, in one flat colour: VS Code's letterpress style. */
function letterpress(fill, opacity) {
  const body = ICON.replace(/<rect width="512" height="512"[^>]*\/>/, "")
    .replace(/<path class="shadow"[^>]*\/>/, "")
    .replace(/<defs>[\s\S]*?<\/defs>/, "")
    .replaceAll('fill="url(#fill)"', `fill="${fill}"`);
  return opacity === undefined ? body : body.replace("<svg ", `<svg opacity="${opacity}" `);
}

const browser = await launch();
const page = await browser.newPage();
await page.setContent("<canvas></canvas>");

/**
 * The icon drawn on a `width` x `height` canvas: `box` is where (x, y, size), `background`
 * fills the canvas first. Returns raw RGBA rows.
 */
async function render(width, height, box, background) {
  const base64 = await page.evaluate(
    async ({ svg, width, height, box, background }) => {
      const canvas = document.querySelector("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, box.x, box.y, box.size, box.size);
      const bytes = ctx.getImageData(0, 0, width, height).data;
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(text);
    },
    { svg: ICON, width, height, box, background },
  );
  return Buffer.from(base64, "base64");
}

const square = (size) => render(size, size, { x: 0, y: 0, size });

// Windows: the .ico (PNG entries, read by Windows Vista and later) and the Start tiles.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = [];
for (const size of icoSizes) icoPngs.push(png(size, size, await square(size)));
write("resources/win32/code.ico", ico(icoSizes, icoPngs));
write("resources/win32/code_70x70.png", png(70, 70, await square(70)));
write("resources/win32/code_150x150.png", png(150, 150, await square(150)));

// The installer's wizard images: a tall side panel and a small header mark, per DPI scale.
for (const scale of SCALES) {
  const f = scale / 100;
  const [bw, bh] = [Math.round(164 * f), Math.round(314 * f)];
  const bigSize = Math.round(bw * 0.6);
  write(
    `resources/win32/inno-big-${scale}.bmp`,
    bmp(bw, bh, await render(bw, bh, { x: (bw - bigSize) / 2, y: bh * 0.18, size: bigSize }, TILE)),
  );
  const s = Math.round(55 * f);
  write(
    `resources/win32/inno-small-${scale}.bmp`,
    bmp(s, s, await render(s, s, { x: 0, y: 0, size: s }, "#FFFFFF")),
  );
}

// Linux.
write("resources/linux/code.png", png(1024, 1024, await square(1024)));

// Inside the app: the title bar and banner icon, and the empty-editor watermark.
write("src/vs/workbench/browser/media/code-icon.svg", ICON);
const media = "src/vs/workbench/browser/parts/editor/media";
write(`${media}/letterpress-dark.svg`, letterpress("#FFFFFF", "0.12"));
write(`${media}/letterpress-light.svg`, letterpress("#000000", "0.1"));
write(`${media}/letterpress-hcDark.svg`, letterpress("#3C3C3C"));
write(`${media}/letterpress-hcLight.svg`, letterpress("#D9D9D9"));

await browser.close();

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("No Edge or Chrome found for playwright-core");
}

/** A PNG from RGBA rows: filter 0 on every row, one zlib stream. */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico whose entries are PNGs. */
function ico(sizes, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngs[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

/** A 24-bit bottom-up BMP (what Inno Setup's wizard images use) from RGBA rows. */
function bmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const target = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      pixels[target + x * 3] = rgba[source + 2];
      pixels[target + x * 3 + 1] = rgba[source + 1];
      pixels[target + x * 3 + 2] = rgba[source];
    }
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(3779, 38); // 96 DPI
  header.writeInt32LE(3779, 42);
  return Buffer.concat([header, pixels]);
}
