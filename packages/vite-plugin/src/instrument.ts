import { parse } from "@babel/parser";
import MagicString, { type SourceMap } from "magic-string";

/**
 * JSX instrumentation (VISUAL_EDITING.md section 6.1, ADR-0009). Adds
 * `data-jesutobits-loc="<file>:<line>:<column>"` to every intrinsic JSX element (lowercase
 * or hyphenated tag) and `data-jesutobits-comp="<Name>"` to the intrinsic elements at the
 * top of each component's returned JSX. Line and column are 1-based and point at the `<`.
 * Only attributes are inserted; everything else stays byte-for-byte the same.
 */

export const LOC_ATTRIBUTE = "data-jesutobits-loc";
export const COMP_ATTRIBUTE = "data-jesutobits-comp";

export interface InstrumentResult {
  code: string;
  map: SourceMap;
  /** Number of elements given a location. */
  elements: number;
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
interface Position {
  line: number;
  column: number;
}
type OpeningElement = Node & {
  name: Node & { name?: string };
  attributes: Array<Node & { name?: { name?: string } }>;
  loc: { start: Position };
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** Depth-first walk over every AST node, skipping position metadata. */
function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (isNode(value[i])) stack.push(value[i]);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

function isIntrinsic(opening: OpeningElement): boolean {
  const { name } = opening;
  return name.type === "JSXIdentifier" && /^[a-z]|-/.test(name.name ?? "");
}

const isFunction = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";

/** The intrinsic opening elements a returned JSX expression starts with. */
function rootElements(expression: unknown): OpeningElement[] {
  if (!isNode(expression)) return [];
  switch (expression.type) {
    case "JSXElement": {
      const opening = expression.openingElement as OpeningElement;
      return isIntrinsic(opening) ? [opening] : [];
    }
    case "JSXFragment":
      return (expression.children as unknown[]).flatMap(rootElements);
    case "ConditionalExpression":
      return [...rootElements(expression.consequent), ...rootElements(expression.alternate)];
    case "LogicalExpression":
      return rootElements(expression.right);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return rootElements(expression.expression);
    default:
      return [];
  }
}

/** `return` statements of a function body, not of functions nested inside it. */
function* ownReturns(body: Node): Generator<Node> {
  for (const node of walkOwn(body)) if (node.type === "ReturnStatement") yield node;
}

function* walkOwn(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child) && !isFunction(child)) stack.push(child);
      }
    }
  }
}

/** Maps the start offset of each component root element to its component name. */
function componentRoots(ast: Node): Map<number, string> {
  const roots = new Map<number, string>();
  const add = (name: string, fn: Node) => {
    if (!/^[A-Z]/.test(name)) return;
    const body = fn.body as Node;
    const expressions =
      body.type === "BlockStatement"
        ? [...ownReturns(body)].map((statement) => statement.argument)
        : [body];
    for (const opening of expressions.flatMap(rootElements)) roots.set(opening.start, name);
  };
  for (const node of walk(ast)) {
    if (node.type === "FunctionDeclaration" && isNode(node.id)) {
      add(String(node.id.name), node);
    } else if (
      node.type === "VariableDeclarator" &&
      isNode(node.id) &&
      node.id.type === "Identifier" &&
      isNode(node.init) &&
      isFunction(node.init)
    ) {
      add(String(node.id.name), node.init);
    }
  }
  return roots;
}

/** A JSX attribute, as a plain string when that is safe and an expression otherwise. */
function attribute(name: string, value: string): string {
  return /^[^"{}<>&\\]*$/.test(value)
    ? ` ${name}="${value}"`
    : ` ${name}={${JSON.stringify(value)}}`;
}

/**
 * Instruments one module. `file` is the project-relative path with forward slashes, as it
 * should appear in the attribute. Returns `null` when there is nothing to change or the
 * file does not parse (the project's own toolchain then reports the syntax error).
 */
export function instrumentJsx(
  code: string,
  file: string,
  typescript: boolean,
): InstrumentResult | null {
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: typescript ? ["jsx", "typescript"] : ["jsx"],
    }) as unknown as Node;
  } catch {
    return null;
  }

  const roots = componentRoots(ast);
  const output = new MagicString(code);
  let elements = 0;
  for (const node of walk(ast)) {
    if (node.type !== "JSXOpeningElement") continue;
    const opening = node as OpeningElement;
    if (!isIntrinsic(opening)) continue;
    if (
      opening.attributes.some((a) => a.type === "JSXAttribute" && a.name?.name === LOC_ATTRIBUTE)
    ) {
      continue;
    }
    const { line, column } = opening.loc.start;
    let inserted = attribute(LOC_ATTRIBUTE, `${file}:${line}:${column + 1}`);
    const component = roots.get(opening.start);
    if (component) inserted += attribute(COMP_ATTRIBUTE, component);
    output.appendLeft(opening.name.end, inserted);
    elements += 1;
  }

  if (elements === 0) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: file, includeContent: true }),
    elements,
  };
}
