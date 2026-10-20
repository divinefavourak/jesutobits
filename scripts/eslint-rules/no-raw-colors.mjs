// Components style only with theme tokens (PROJECT_STRUCTURE.md section 3.2,
// EXTENSION_SYSTEM.md section 4). Reports colour literals and Tailwind palette classes in
// string literals, template strings and JSX text.
const HEX = /#[0-9a-f]{3,8}\b/i;
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?\b/;

function findColor(text) {
  return HEX.exec(text)?.[0] ?? FUNCTION.exec(text)?.[0] ?? PALETTE.exec(text)?.[0];
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw colours; use theme tokens" },
    schema: [],
    messages: {
      raw: "Raw colour '{{value}}': use a theme token (CSS variable or token utility class) instead.",
    },
  },
  create(context) {
    function check(node, text) {
      const value = typeof text === "string" ? findColor(text) : undefined;
      if (value) context.report({ node, messageId: "raw", data: { value } });
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
      JSXText: (node) => check(node, node.value),
    };
  },
};
