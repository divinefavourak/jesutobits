import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

function renderMarkdown(text: string) {
  return render(<Markdown text={text} />);
}

describe("Markdown rendering", () => {
  it("renders headings with modest levels", () => {
    renderMarkdown("# Title\n\n## Sub\n\n### Small");
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Sub" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Small" })).toBeTruthy();
  });

  it("renders paragraphs, inline code and emphasis", () => {
    const { container } = renderMarkdown("plain **bold** *em* ~~gone~~ `code`");
    expect(screen.getByText("plain")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders fenced code verbatim with a language label", () => {
    const { container } = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(screen.getByText("ts")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });

  it("renders unordered and ordered lists", () => {
    const { container: unordered } = renderMarkdown("- one\n- two");
    expect(unordered.querySelector("ul")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    const { container: ordered } = renderMarkdown("3. three\n4. four");
    expect(ordered.querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("renders task items as labelled spans, not inputs", () => {
    const { container } = renderMarkdown("- [x] done\n- [ ] todo");
    expect(screen.getByLabelText("done")).toBeTruthy();
    expect(screen.getByLabelText("not done")).toBeTruthy();
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders nested lists and blockquotes", () => {
    const { container } = renderMarkdown("> - one\n>   - nested");
    expect(container.querySelector("blockquote ul ul")).toBeTruthy();
  });

  it("renders tables with headers and cells", () => {
    renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "a" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "1" })).toBeTruthy();
  });

  it("renders thematic breaks", () => {
    const { container } = renderMarkdown("above\n\n---\n\nbelow");
    expect(container.querySelector("hr")).toBeTruthy();
  });
});

describe("Markdown security (SECURITY.md section 8)", () => {
  it("shows a script tag as text and creates no script element", () => {
    const { container } = renderMarkdown("<script>alert(1)</script>");
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
  });

  it("shows an event-handler tag as text and creates no element or attribute", () => {
    const { container } = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("shows other raw HTML tags as text", () => {
    const { container } = renderMarkdown("<b>not bold</b>");
    expect(container.textContent).toContain("<b>not bold</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("replaces images with a placeholder and never renders img", () => {
    const { container } = renderMarkdown("![alt](https://example.com/x.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Image not loaded: alt (example.com)")).toBeTruthy();
  });

  it("never renders an anchor and shows the real URL next to the label", () => {
    const { container } = renderMarkdown("[docs](https://example.com/a)");
    expect(container.querySelector("a")).toBeNull();
    const link = container.querySelector("[data-href]");
    expect(link?.getAttribute("data-href")).toBe("https://example.com/a");
    expect(link?.getAttribute("title")).toBe("https://example.com/a");
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText("https://example.com/a")).toBeTruthy();
  });

  it("does not duplicate the URL when the label is the URL", () => {
    const { container } = renderMarkdown("[https://example.com/a](https://example.com/a)");
    expect(container.querySelectorAll("[data-href]")).toHaveLength(1);
    expect(screen.getAllByText("https://example.com/a")).toHaveLength(1);
  });

  it("strips data-href from a javascript: URL", () => {
    const { container } = renderMarkdown("[x](javascript:alert(1))");
    expect(container.querySelector("[data-href]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("x");
  });

  it("strips data-href from other active schemes", () => {
    const { container } = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(container.querySelector("[data-href]")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps bare URLs as plain text", () => {
    const { container } = renderMarkdown("see https://example.com/a for details");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[data-href]")).toBeNull();
    expect(container.textContent).toContain("https://example.com/a");
  });
});
