// Configurable child process for ProcessSupervisor tests (TESTING_STRATEGY.md section 3.2).
// Plain JavaScript with Node built-ins only, so it runs without a build.
//
//   node fake-cmd.mjs [flags] [--] [args...]
//   --print-args            write {"args": [...]} (everything after the flags) to stdout
//   --print-env             write {"env": {...}} to stdout
//   --print-cwd             write {"cwd": "..."} to stdout
//   --stdout <text>         write text to stdout;  --stderr <text> to stderr
//   --bytes <n>             write n bytes of "x" to stdout
//   --sleep <ms>            wait before exiting
//   --exit <code>           exit code (default 0)
//   --ignore-term           ignore SIGTERM (needs a hard kill)
//   --grandchild <file>     start a long-lived grandchild and write its pid to <file>
//   --version-output <text> print text and exit (stands in for `tool --version`)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--") {
    rest.push(...argv.slice(i + 1));
    break;
  }
  if (["--print-args", "--print-env", "--print-cwd", "--ignore-term"].includes(arg)) {
    flags[arg.slice(2)] = true;
  } else if (arg.startsWith("--") && i + 1 < argv.length) {
    flags[arg.slice(2)] = argv[++i];
  } else {
    rest.push(arg);
  }
}

if (flags["version-output"] !== undefined) {
  process.stdout.write(`${flags["version-output"]}\n`);
  process.exit(0);
}
if (flags["ignore-term"]) process.on("SIGTERM", () => {});
if (flags.grandchild) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(flags.grandchild, String(child.pid));
}
if (flags["print-args"]) process.stdout.write(`${JSON.stringify({ args: rest })}\n`);
if (flags["print-env"]) process.stdout.write(`${JSON.stringify({ env: process.env })}\n`);
if (flags["print-cwd"]) process.stdout.write(`${JSON.stringify({ cwd: process.cwd() })}\n`);
if (flags.stdout !== undefined) process.stdout.write(flags.stdout);
if (flags.stderr !== undefined) process.stderr.write(flags.stderr);
if (flags.bytes !== undefined) process.stdout.write("x".repeat(Number(flags.bytes)));

// Exit only after stdout has flushed, so large outputs arrive whole through a pipe.
const finish = () => process.stdout.write("", () => process.exit(Number(flags.exit ?? 0)));
if (flags.sleep !== undefined) setTimeout(finish, Number(flags.sleep));
else finish();
