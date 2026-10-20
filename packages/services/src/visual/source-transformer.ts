import { parse } from "@babel/parser";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import MagicString from "magic-string";

/**
 * Persistent visual edits (VISUAL_EDITING.md section 8, ADR-0009 decision 5): re-parse the
 * file, find the JSX element at an instrumented location, check the attribute is statically
 * editable, and splice only that attribute's text. No formatter runs; line endings and
 * everything outside the attribute stay byte-for-byte the same.
 *
 * Spike S2 scope: class lists on `className` (or `class` on custom elements). Tailwind
 * value mapping and merge rules (section 8.2) arrive in Phase 5.
 */

export interface SourceLocation {
  line: number;
  /** 1-based, pointing at the `<`, as in `data-jesutobits-loc`. */
  column: number;
}

export interface ClassEdit {
  remove: string[];
  add: string[];
}

export interface EditResult {
  code: string;
  /** Where the element starts after the edit. Unchanged, since edits follow the tag name. */
  loc: SourceLocation;
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Attribute = Node & { name: { name?: string }; value: Node | null };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** Parses `data-jesutobits-loc` (`src/Hero.tsx:24:7`) into path and location. */
export function parseLoc(loc: string): { file: string; loc: SourceLocation } {
  const match = /^(.+):(\d+):(\d+)$/.exec(loc);
  if (!match)
    throw new JesutobitsError(ErrorCodes.visualElementNotFound, `Invalid location ${loc}`);
  return { file: match[1]!, loc: { line: Number(match[2]), column: Number(match[3]) } };
}

function findOpeningElement(code: string, typescript: boolean, at: SourceLocation): Node {
  const ast = parse(code, {
    sourceType: "module",
    plugins: typescript ? ["jsx", "typescript"] : ["jsx"],
  });
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isNode(node)) continue;
    if (node.type === "JSXOpeningElement") {
      const start = (node.loc as { start: { line: number; column: number } }).start;
      if (start.line === at.line && start.column + 1 === at.column) return node;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc") stack.push(...(Array.isArray(value) ? value : [value]));
    }
  }
  throw new JesutobitsError(
    ErrorCodes.visualElementNotFound,
    `No JSX element starts at line ${at.line}, column ${at.column}`,
  );
}

function applyToClassList(current: string, edit: ClassEdit): string {
  const remove = new Set(edit.remove);
  const kept = current.split(/\s+/).filter((name) => name !== "" && !remove.has(name));
  for (const name of edit.add) if (!kept.includes(name)) kept.push(name);
  return kept.join(" ");
}

/** Edits the class list of the JSX element starting at `loc`. */
export function applyClassEdit(
  code: string,
  options: { typescript: boolean; loc: SourceLocation; edit: ClassEdit },
): EditResult {
  const opening = findOpeningElement(code, options.typescript, options.loc);
  const name = opening.name as Node & { name?: string };
  const attrName = /-/.test(name.name ?? "") ? "class" : "className";
  const attributes = opening.attributes as Node[];
  const attr = attributes.find(
    (a): a is Attribute => a.type === "JSXAttribute" && (a as Attribute).name.name === attrName,
  );
  const output = new MagicString(code);

  if (!attr) {
    const value = applyToClassList("", options.edit);
    output.appendLeft(name.end, ` ${attrName}="${value}"`);
    return { code: output.toString(), loc: options.loc };
  }

  const value = attr.value;
  if (value?.type === "StringLiteral") {
    // Inside the quotes, so the quote style is kept.
    const next = applyToClassList(String(value.value), options.edit);
    output.overwrite(value.start + 1, value.end - 1, next);
    return { code: output.toString(), loc: options.loc };
  }

  // className={`a b`} with no expressions is still static (section 7.2).
  const expression =
    value?.type === "JSXExpressionContainer" ? (value.expression as Node) : undefined;
  if (
    expression?.type === "TemplateLiteral" &&
    (expression.expressions as unknown[]).length === 0
  ) {
    const quasi = (expression.quasis as Node[])[0]!;
    const next = applyToClassList(code.slice(quasi.start, quasi.end), options.edit);
    output.overwrite(quasi.start, quasi.end, next);
    return { code: output.toString(), loc: options.loc };
  }

  throw new JesutobitsError(
    ErrorCodes.visualNotEditable,
    `The ${attrName} of this element is computed. Ask the agent to change it.`,
    { details: { attribute: attrName } },
  );
}
