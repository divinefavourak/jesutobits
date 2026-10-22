// The development cassette named by JESUTOBITS_CASSETTE (DEVELOPMENT_SETUP.md section 4). This
// is the only file the scripted provider reads, and never a project file, so the boundary
// rules let this module use node:fs (PROJECT_STRUCTURE.md section 3.2).
import { readFileSync } from "node:fs";
import { parseCassette, type CassetteLine } from "./cassette.js";

export function readCassetteFile(path: string): CassetteLine[] {
  return parseCassette(readFileSync(path, "utf8"));
}
