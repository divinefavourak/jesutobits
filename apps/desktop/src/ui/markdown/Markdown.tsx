import { useMemo, type ReactNode } from "react";
import { t } from "../../i18n";
import { parseMarkdown, type Block, type ListItem, type Inline, type TableAlign } from "./parse";

/**
 * Renders untrusted Markdown as React elements only (SECURITY.md section 8).
 *
 * - No HTML is ever produced from strings: raw HTML in the source stays text.
 * - No remote resource is loaded: images become a labelled placeholder.
 * - No navigable link is rendered: links become spans carrying `data-href`, and unsafe
 *   schemes such as `javascript:` lose the URL entirely.
 */

const HEADING_CLASSES: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "mt-2 text-lg font-semibold leading-snug",
  2: "mt-2 text-base font-semibold leading-snug",
  3: "mt-1 text-sm font-semibold leading-snug",
  4: "mt-1 text-sm font-semibold leading-snug",
  5: "mt-1 text-xs font-semibold uppercase tracking-wide text-text-muted",
  6: "mt-1 text-xs font-semibold uppercase tracking-wide text-text-subtle",
};

const ALIGN_CLASSES: Record<Exclude<TableAlign, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** Rejects any scheme that is not a plain web/mail link; relative URLs pass. */
function safeHref(href: string): string | null {
  const compact = href.replace(/\s+/g, "").toLowerCase();
  if (compact === "") return null;
  const match = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  if (!match) return href;
  const scheme = match[1];
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

/** The host to show in an image placeholder, or the raw URL when it does not parse. */
function imageTarget(src: string): string {
  try {
    const url = new URL(src);
    return url.host !== "" ? url.host : src;
  } catch {
    return src;
  }
}

function plainText(nodes: Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
        out += node.value;
        break;
      case "strong":
      case "em":
      case "strike":
      case "link":
        out += plainText(node.children);
        break;
      case "image":
        out += node.alt;
        break;
    }
  }
  return out;
}

function TaskBox({ done }: { done: boolean }) {
  return (
    <span
      aria-label={done ? t("markdown.taskDone") : t("markdown.taskNotDone")}
      className="mr-1 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border border-border align-middle text-xs leading-none text-text-muted"
    >
      {done ? "✓" : ""}
    </span>
  );
}

function InlineView({ node }: { node: Inline }) {
  switch (node.type) {
    case "text":
      return <>{node.value}</>;
    case "code":
      return (
        <code className="rounded-sm border border-border bg-surface-sunken px-1 py-0.5 font-mono text-xs">
          {node.value}
        </code>
      );
    case "strong":
      return <strong className="font-semibold">{renderInlines(node.children)}</strong>;
    case "em":
      return <em>{renderInlines(node.children)}</em>;
    case "strike":
      return <del>{renderInlines(node.children)}</del>;
    case "link": {
      const href = safeHref(node.href);
      if (href === null) return <>{plainText(node.children)}</>;
      const label = plainText(node.children).trim();
      return (
        <>
          <span data-href={href} title={href} className="break-all text-accent">
            {renderInlines(node.children)}
          </span>
          {label !== href ? (
            <span className="ml-1 break-all text-xs text-text-muted">{href}</span>
          ) : null}
        </>
      );
    }
    case "image": {
      const target = imageTarget(node.src);
      const alt = node.alt.trim();
      return (
        <span className="rounded-sm border border-border bg-surface-sunken px-1 text-xs text-text-muted">
          {alt === "" ? t("markdown.imageNoAlt", { target }) : t("markdown.image", { alt, target })}
        </span>
      );
    }
  }
}

function renderInlines(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => <InlineView key={`${node.type}-${index}`} node={node} />);
}

function ListItemView({ item }: { item: ListItem }) {
  const done = item.task === "done";
  return (
    <li className="break-words leading-relaxed">
      {item.blocks.map((block, index) =>
        index === 0 && item.task && block.type === "paragraph" ? (
          <p key={`${block.type}-${index}`} className="break-words leading-relaxed">
            <TaskBox done={done} />
            {renderInlines(block.children)}
          </p>
        ) : (
          <BlockView key={`${block.type}-${index}`} block={block} />
        ),
      )}
      {item.blocks.length === 0 && item.task ? <TaskBox done={done} /> : null}
    </li>
  );
}

function TableView({ block }: { block: Extract<Block, { type: "table" }> }) {
  return (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr>
            {block.header.map((cell, column) => {
              const align = block.align[column] ?? null;
              return (
                <th
                  key={column}
                  className={`border border-border bg-surface-sunken px-2 py-1 font-semibold ${
                    align ? ALIGN_CLASSES[align] : ""
                  }`}
                >
                  {renderInlines(cell)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => {
                const align = block.align[column] ?? null;
                return (
                  <td
                    key={column}
                    className={`border border-border px-2 py-1 align-top ${
                      align ? ALIGN_CLASSES[align] : ""
                    }`}
                  >
                    {renderInlines(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "paragraph":
      return <p className="break-words leading-relaxed">{renderInlines(block.children)}</p>;

    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className={HEADING_CLASSES[block.level]}>{renderInlines(block.children)}</Tag>;
    }

    case "codeBlock":
      return (
        <div className="my-1 overflow-hidden rounded-md border border-border bg-surface-sunken">
          {block.lang ? (
            <div className="border-b border-border px-2 py-0.5 text-xs text-text-muted">
              {block.lang}
            </div>
          ) : null}
          <pre className="overflow-x-auto p-2 text-xs leading-relaxed">
            <code className="font-mono">{block.value}</code>
          </pre>
        </div>
      );

    case "blockquote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-text-muted">
          {block.children.map((child, index) => (
            <BlockView key={`${child.type}-${index}`} block={child} />
          ))}
        </blockquote>
      );

    case "list": {
      const items = block.items.map((item, index) => <ListItemView key={index} item={item} />);
      if (block.ordered) {
        return (
          <ol
            start={block.start > 1 ? block.start : undefined}
            className="my-1 list-decimal space-y-1 pl-5"
          >
            {items}
          </ol>
        );
      }
      return <ul className="my-1 list-disc space-y-1 pl-5">{items}</ul>;
    }

    case "table":
      return <TableView block={block} />;

    case "thematicBreak":
      return <hr className="my-2 border-t border-border" />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="markdown flex flex-col gap-2 break-words text-sm text-text">
      {blocks.map((block, index) => (
        <BlockView key={`${block.type}-${index}`} block={block} />
      ))}
    </div>
  );
}
