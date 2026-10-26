import { describe, expect, it } from "vitest";
import { inlineText, parseMarkdown, type Block } from "./parse";

function block<T extends Block["type"]>(text: string, type: T): Extract<Block, { type: T }> {
  const found = parseMarkdown(text).find((candidate) => candidate.type === type);
  if (!found || found.type !== type) throw new Error(`expected a ${type} block`);
  return found as Extract<Block, { type: T }>;
}

function itemText(item: { blocks: Block[] }): string {
  const first = item.blocks[0];
  return first && first.type === "paragraph" ? inlineText(first.children) : "";
}

describe("parseMarkdown blocks", () => {
  it("parses ATX headings from one to six hashes", () => {
    const text = "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six";
    const blocks = parseMarkdown(text);
    expect(blocks.map((current) => current.type)).toEqual([
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
    ]);
    const expected = ["One", "Two", "Three", "Four", "Five", "Six"];
    blocks.forEach((current, index) => {
      if (current.type !== "heading") throw new Error("not a heading");
      expect(current.level).toBe(index + 1);
      expect(inlineText(current.children)).toBe(expected[index]);
    });
  });

  it("does not treat #hashtag as a heading", () => {
    expect(parseMarkdown("#hashtag")[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "#hashtag" }],
    });
  });

  it("separates paragraphs on blank lines and joins single newlines with a space", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "one two" }],
    });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "three" }],
    });
  });

  it("shows raw HTML as literal text", () => {
    expect(parseMarkdown("<b>hi</b>")[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "<b>hi</b>" }],
    });
  });

  it("parses fenced code with and without an info string", () => {
    expect(block("```tsx\nconst a = 1;\n```", "codeBlock")).toEqual({
      type: "codeBlock",
      lang: "tsx",
      value: "const a = 1;",
    });
    expect(block("~~~python\nprint(1)\n~~~", "codeBlock")).toEqual({
      type: "codeBlock",
      lang: "python",
      value: "print(1)",
    });
    expect(block("```\nplain\n```", "codeBlock")).toEqual({
      type: "codeBlock",
      lang: null,
      value: "plain",
    });
    expect(block("```js extra words\nx\n```", "codeBlock")).toEqual({
      type: "codeBlock",
      lang: "js",
      value: "x",
    });
  });

  it("runs an unclosed fence to the end of the input", () => {
    expect(block("```\nline 1\nline 2", "codeBlock")).toEqual({
      type: "codeBlock",
      lang: null,
      value: "line 1\nline 2",
    });
  });

  it("parses thematic breaks", () => {
    expect(parseMarkdown("---\n\n***\n\n___").map((current) => current.type)).toEqual([
      "thematicBreak",
      "thematicBreak",
      "thematicBreak",
    ]);
  });
});

describe("parseMarkdown inlines", () => {
  it("parses code, strong, em, strike and links in one paragraph", () => {
    const paragraph = block("**bold** *em* ~~gone~~ `code`", "paragraph");
    expect(paragraph.children).toEqual([
      { type: "strong", children: [{ type: "text", value: "bold" }] },
      { type: "text", value: " " },
      { type: "em", children: [{ type: "text", value: "em" }] },
      { type: "text", value: " " },
      { type: "strike", children: [{ type: "text", value: "gone" }] },
      { type: "text", value: " " },
      { type: "code", value: "code" },
    ]);
  });

  it("nests emphasis the way CommonMark does for ***both***", () => {
    expect(block("***both***", "paragraph").children).toEqual([
      {
        type: "em",
        children: [{ type: "strong", children: [{ type: "text", value: "both" }] }],
      },
    ]);
  });

  it("handles em and strong nested inside each other", () => {
    expect(block("**a *b* c**", "paragraph").children).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "a " },
          { type: "em", children: [{ type: "text", value: "b" }] },
          { type: "text", value: " c" },
        ],
      },
    ]);
    expect(block("*a **b** c*", "paragraph").children).toEqual([
      {
        type: "em",
        children: [
          { type: "text", value: "a " },
          { type: "strong", children: [{ type: "text", value: "b" }] },
          { type: "text", value: " c" },
        ],
      },
    ]);
  });

  it("supports underscores and leaves intraword underscores alone", () => {
    expect(block("__strong__", "paragraph").children).toEqual([
      { type: "strong", children: [{ type: "text", value: "strong" }] },
    ]);
    expect(block("snake_case_name", "paragraph").children).toEqual([
      { type: "text", value: "snake_case_name" },
    ]);
  });

  it("honours backslash escapes", () => {
    expect(block("\\*not em\\* and \\`not code\\`", "paragraph").children).toEqual([
      { type: "text", value: "*not em* and `not code`" },
    ]);
  });

  it("keeps unclosed emphasis delimiters as literal text", () => {
    expect(block("*open", "paragraph").children).toEqual([{ type: "text", value: "*open" }]);
    expect(block("~~open", "paragraph").children).toEqual([{ type: "text", value: "~~open" }]);
    expect(block("close**", "paragraph").children).toEqual([{ type: "text", value: "close**" }]);
  });

  it("parses links and images", () => {
    const paragraph = block(
      "[docs](https://example.com/a) and ![alt](https://example.com/x.png)",
      "paragraph",
    );
    expect(paragraph.children[0]).toEqual({
      type: "link",
      href: "https://example.com/a",
      children: [{ type: "text", value: "docs" }],
    });
    expect(paragraph.children[1]).toEqual({ type: "text", value: " and " });
    expect(paragraph.children[2]).toEqual({
      type: "image",
      src: "https://example.com/x.png",
      alt: "alt",
    });
  });

  it("keeps labels with balanced brackets together", () => {
    expect(block("Use [a] and [b](https://example.com)", "paragraph").children).toEqual([
      { type: "text", value: "Use [a] and " },
      {
        type: "link",
        href: "https://example.com",
        children: [{ type: "text", value: "b" }],
      },
    ]);
  });

  it("does not throw on a link without a destination", () => {
    expect(block("[a] and [b]", "paragraph").children).toEqual([
      { type: "text", value: "[a] and [b]" },
    ]);
  });
});

describe("parseMarkdown lists and quotes", () => {
  it("parses unordered lists", () => {
    const list = block("- a\n- b", "list");
    expect(list.ordered).toBe(false);
    expect(list.items.map(itemText)).toEqual(["a", "b"]);
  });

  it("parses ordered lists with . and ) markers and keeps the start number", () => {
    const list = block("3. a\n4. b", "list");
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items.map(itemText)).toEqual(["a", "b"]);

    expect(block("1) a\n2) b", "list").items.map(itemText)).toEqual(["a", "b"]);
  });

  it("allows a blank line between list items", () => {
    const list = block("- a\n\n- b", "list");
    expect(list.items).toHaveLength(2);
  });

  it("nests lists by indentation", () => {
    const list = block("- a\n  - b\n- c", "list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.blocks.map((current) => current.type)).toEqual(["paragraph", "list"]);
  });

  it("marks task items", () => {
    const list = block("- [ ] todo\n- [x] done", "list");
    expect(list.items.map((item) => item.task)).toEqual(["todo", "done"]);
    expect(itemText(list.items[1]!)).toBe("done");
  });

  it("puts fenced code inside a list item", () => {
    const list = block("- item\n\n  ```js\n  const x = 1;\n  ```", "list");
    const blocks = list.items[0]?.blocks ?? [];
    expect(blocks.map((current) => current.type)).toEqual(["paragraph", "codeBlock"]);
    expect(blocks[1]).toEqual({ type: "codeBlock", lang: "js", value: "const x = 1;" });
  });

  it("parses blockquotes, including nested lists and quotes", () => {
    const quote = block("> - a\n> - b", "blockquote");
    expect(quote.children.map((current) => current.type)).toEqual(["list"]);

    const nested = block("> > deep", "blockquote");
    expect(nested.children[0]?.type).toBe("blockquote");
  });

  it("keeps list content inside a quote", () => {
    const quote = block("> intro\n>\n> - one", "blockquote");
    expect(quote.children.map((current) => current.type)).toEqual(["paragraph", "list"]);
  });
});

describe("parseMarkdown tables", () => {
  it("parses a GFM table with alignment", () => {
    const table = block("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |", "table");
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header.map(inlineText)).toEqual(["a", "b", "c"]);
    expect(table.rows.map((row) => row.map(inlineText))).toEqual([["1", "2", "3"]]);
  });

  it("pads short rows and parses inline markup in cells", () => {
    const table = block("| a | b |\n|---|---|\n| **x** |", "table");
    expect(table.rows[0]?.map(inlineText)).toEqual(["x", ""]);
    expect(table.rows[0]?.[0]?.[0]).toEqual({
      type: "strong",
      children: [{ type: "text", value: "x" }],
    });
  });

  it("does not treat a row without a separator as a table", () => {
    expect(parseMarkdown("| a | b |")[0]?.type).toBe("paragraph");
  });
});

describe("parseMarkdown edge cases", () => {
  it("returns no blocks for empty or whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown(" \n\t\r\n ")).toEqual([]);
  });

  it("handles Windows CRLF line endings", () => {
    const blocks = parseMarkdown("# Title\r\n\r\nBody\r\nline");
    expect(blocks).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", value: "Title" }] },
      { type: "paragraph", children: [{ type: "text", value: "Body line" }] },
    ]);
  });

  it("handles very long lines without throwing", () => {
    const long = "a".repeat(100_000);
    const paragraph = block(long, "paragraph");
    expect(inlineText(paragraph.children)).toHaveLength(100_000);
  });

  it("handles deeply nested quotes without throwing", () => {
    expect(() => parseMarkdown(">".repeat(5_000))).not.toThrow();
  });

  it("handles a pathological run of opening brackets without throwing", () => {
    const text = `${"[".repeat(5_000)}${"]".repeat(5_000)}`;
    expect(() => parseMarkdown(text)).not.toThrow();
  });
});

describe("parseMarkdown performance", () => {
  it("parses 200 KB of mixed Markdown in under 500 ms", () => {
    const chunk = [
      "# Heading",
      "",
      "Some **bold** and *em* text with a [link](https://example.com/path) and `code`.",
      "",
      "- item one",
      "- item two",
      "  - nested",
      "",
      "> quoted text",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "",
    ].join("\n");
    const text = chunk.repeat(Math.ceil(200_000 / chunk.length)).slice(0, 200_000);

    // Warm the JIT so the measurement covers the parser, not first-call compilation.
    parseMarkdown(chunk);

    const started = performance.now();
    const blocks = parseMarkdown(text);
    const elapsed = performance.now() - started;

    expect(blocks.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});
