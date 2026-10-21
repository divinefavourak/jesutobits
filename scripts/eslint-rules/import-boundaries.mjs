// ESLint rule enforcing the dependency rules in PROJECT_STRUCTURE.md section 3 (NFR-017).
//
// One rule with one table, instead of stacked `no-restricted-imports` blocks: flat config
// replaces a rule's options per matching block, so overlapping folders would silently lose
// restrictions.
//
// Options: [{ root, rules: [{ files, except?, imports, allowTypeOnly?, message }],
//             isolate: [{ dir, shared, message }] }]
//   files/except  repo-relative path prefixes ("packages/services/src/")
//   tests         false to skip test files (tests may use node:fs for temp dirs, for example)
//   imports       regex sources matched against the import specifier
//   isolate       sibling folders under `dir` may not import each other, except `shared`
// Relative imports may never leave their own package, except that test code (unit tests,
// test/ and e2e/ folders) may import the repository's development scripts in scripts/.
import { dirname, relative, resolve, sep } from "node:path";

const toPosix = (p) => p.split(sep).join("/");
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$|\/test\/|\/e2e\/)/;

/** `packages/<name>/` or `apps/<name>/` for a repo-relative path, if any. */
function packageRoot(relPath) {
  const match = /^(packages|apps)\/[^/]+\//.exec(relPath);
  return match ? match[0] : undefined;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Enforce Jesutobits package and module boundaries" },
    schema: [{ type: "object" }],
    messages: {
      restricted: "{{message}} (import '{{source}}')",
      escapesPackage: "Relative import '{{source}}' leaves {{pkg}}; depend on the package instead.",
      crossesSibling: "{{message}} ('{{from}}' imports '{{to}}')",
    },
  },
  create(context) {
    const { root, rules = [], isolate = [] } = context.options[0] ?? {};
    const file = toPosix(relative(root, context.filename));
    const matches = (prefixes = []) => prefixes.some((p) => file.startsWith(p));
    const isTest = TEST_FILE.test(file);
    const active = rules
      .filter(
        (rule) => matches(rule.files) && !matches(rule.except) && !(isTest && rule.tests === false),
      )
      .map((rule) => ({ ...rule, patterns: rule.imports.map((source) => new RegExp(source)) }));
    const pkg = packageRoot(file);

    function check(node, source, typeOnly) {
      if (typeof source !== "string") return;

      for (const rule of active) {
        if (typeOnly && rule.allowTypeOnly) continue;
        if (rule.patterns.some((pattern) => pattern.test(source))) {
          context.report({
            node,
            messageId: "restricted",
            data: { message: rule.message, source },
          });
        }
      }

      if (!source.startsWith(".")) return;
      const target = toPosix(relative(root, resolve(dirname(context.filename), source)));
      const devScript = isTest && target.startsWith("scripts/");
      if (pkg && !`${target}/`.startsWith(pkg) && !devScript) {
        context.report({ node, messageId: "escapesPackage", data: { source, pkg } });
      }
      for (const { dir, shared = [], message } of isolate) {
        if (!file.startsWith(dir) || !target.startsWith(dir)) continue;
        const from = file.slice(dir.length).split("/")[0];
        const to = target.slice(dir.length).split("/")[0];
        // Files directly in `dir` (the registry) may import any sibling.
        if (!file.slice(dir.length).includes("/")) continue;
        if (from !== to && !shared.includes(to)) {
          context.report({ node, messageId: "crossesSibling", data: { message, from, to } });
        }
      }
    }

    const isTypeOnly = (node) =>
      node.importKind === "type" ||
      node.exportKind === "type" ||
      (node.specifiers?.length > 0 && node.specifiers.every((s) => s.importKind === "type"));

    return {
      ImportDeclaration: (node) => check(node, node.source.value, isTypeOnly(node)),
      ExportNamedDeclaration: (node) =>
        node.source && check(node, node.source.value, isTypeOnly(node)),
      ExportAllDeclaration: (node) => check(node, node.source.value, isTypeOnly(node)),
      ImportExpression: (node) =>
        node.source.type === "Literal" && check(node, node.source.value, false),
      TSImportEqualsDeclaration: (node) =>
        node.moduleReference.type === "TSExternalModuleReference" &&
        check(node, node.moduleReference.expression.value, node.importKind === "type"),
    };
  },
};
