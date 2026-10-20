import importBoundaries from "./import-boundaries.mjs";
import noRawColors from "./no-raw-colors.mjs";

/** Local ESLint plugin for Jesutobits architecture rules. */
export default {
  meta: { name: "eslint-plugin-jesutobits" },
  rules: {
    "import-boundaries": importBoundaries,
    "no-raw-colors": noRawColors,
  },
};
