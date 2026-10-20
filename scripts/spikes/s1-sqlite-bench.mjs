// Spike S1: node:sqlite with WAL, 10k event inserts in under 2 s (ROADMAP Phase 0).
//
// Inserts runtime-event-shaped rows (about 400 bytes of JSON each) into a fresh database in
// the temp folder, in three write patterns the event store could use:
//   one-transaction   all rows in one transaction
//   batches-of-100    a transaction per 100 rows (a flush every few hundred ms of events)
//   autocommit        one implicit transaction per row (the worst case)
// with journal_mode=WAL and synchronous=NORMAL (ADR-0008).
//
//   node scripts/spikes/s1-sqlite-bench.mjs [--rows 10000] [--runs 3]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return Number(index === -1 ? fallback : process.argv[index + 1]);
};
const ROWS = arg("--rows", 10_000);
const RUNS = arg("--runs", 3);
const BUDGET_MS = 2000;

function event(seq) {
  return {
    seq,
    ts: new Date(1_760_000_000_000 + seq).toISOString(),
    type: "tool.output_delta",
    sessionId: "ses_01JAAAAAAAAAAAAAAAAAAAAAAA",
    turnId: "trn_01JAAAAAAAAAAAAAAAAAAAAAAA",
    callId: `call_01JAAAAAAAAAAAAAAAAAAA${String(seq % 1000).padStart(4, "0")}`,
    text: "x".repeat(240),
  };
}

function open(dir) {
  const db = new DatabaseSync(join(dir, "jesutobits.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    session_id TEXT,
    turn_id TEXT,
    payload TEXT NOT NULL
  )`);
  return db;
}

const patterns = {
  "one-transaction": (db, insert, rows) => {
    db.exec("BEGIN");
    for (const row of rows) insert(row);
    db.exec("COMMIT");
  },
  "batches-of-100": (db, insert, rows) => {
    for (let i = 0; i < rows.length; i += 100) {
      db.exec("BEGIN");
      for (const row of rows.slice(i, i + 100)) insert(row);
      db.exec("COMMIT");
    }
  },
  autocommit: (_db, insert, rows) => {
    for (const row of rows) insert(row);
  },
};

const rows = Array.from({ length: ROWS }, (_, i) => event(i));
const results = {};
for (const [name, write] of Object.entries(patterns)) {
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    const dir = mkdtempSync(join(tmpdir(), "jesutobits-sqlite-"));
    const db = open(dir);
    const statement = db.prepare(
      "INSERT INTO events (seq, ts, type, session_id, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insert = (e) =>
      statement.run(e.seq, e.ts, e.type, e.sessionId, e.turnId, JSON.stringify(e));

    const start = performance.now();
    write(db, insert, rows);
    times.push(performance.now() - start);

    const { count } = db.prepare("SELECT count(*) AS count FROM events").get();
    if (count !== ROWS) throw new Error(`${name}: expected ${ROWS} rows, found ${count}`);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  results[name] = {
    bestMs: Math.round(Math.min(...times)),
    worstMs: Math.round(Math.max(...times)),
    withinBudget: Math.max(...times) < BUDGET_MS,
  };
}

process.stdout.write(
  `${JSON.stringify({ node: process.version, rows: ROWS, runs: RUNS, results }, null, 2)}\n`,
);
