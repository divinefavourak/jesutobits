import { describe, expect, it } from "vitest";
import { instrumentJsx } from "./instrument.js";

describe("instrumentJsx", () => {
  // The example from VISUAL_EDITING.md section 6.1, byte for byte.
  it("produces the documented transform", () => {
    const source = [
      "export function Hero() {",
      "  return (",
      '    <section className="py-24">',
      '      <h1 className="text-4xl font-bold">Track habits</h1>',
      "      <Button onClick={start}>Get started</Button>",
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    const result = instrumentJsx(source, "src/components/Hero.tsx", true);
    expect(result?.code).toBe(
      [
        "export function Hero() {",
        "  return (",
        '    <section data-jesutobits-loc="src/components/Hero.tsx:3:5" data-jesutobits-comp="Hero" className="py-24">',
        '      <h1 data-jesutobits-loc="src/components/Hero.tsx:4:7" className="text-4xl font-bold">Track habits</h1>',
        "      <Button onClick={start}>Get started</Button>",
        "    </section>",
        "  );",
        "}",
      ].join("\n"),
    );
    expect(result?.elements).toBe(2);
  });

  it("counts CRLF line breaks as one line", () => {
    const source = "const A = () => (\r\n  <div>\r\n    <span>x</span>\r\n  </div>\r\n);\r\n";
    const code = instrumentJsx(source, "a.tsx", true)?.code ?? "";
    expect(code).toContain('<div data-jesutobits-loc="a.tsx:2:3" data-jesutobits-comp="A">');
    expect(code).toContain('<span data-jesutobits-loc="a.tsx:3:5">');
    // Line endings are untouched.
    expect(code.split("\r\n")).toHaveLength(source.split("\r\n").length);
  });

  it("skips components, member expressions, namespaced names and fragments", () => {
    const source = "const x = <><Card /><motion.div /><svg:rect /><Ctx.Provider value={1} /></>;";
    expect(instrumentJsx(source, "x.jsx", false)).toBeNull();
  });

  it("instruments custom elements and self-closing tags", () => {
    const code = instrumentJsx(
      'const x = <><img src="a" /><status-badge /></>;',
      "x.jsx",
      false,
    )?.code;
    expect(code).toContain('<img data-jesutobits-loc="x.jsx:1:13" src="a" />');
    expect(code).toContain('<status-badge data-jesutobits-loc="x.jsx:1:28" />');
  });

  it("marks every root of a fragment, conditional and arrow component", () => {
    const source = [
      "export const Footer = () => {",
      "  if (hidden) return null;",
      "  return ok ? <><hr /><footer /></> : <aside />;",
      "};",
    ].join("\n");
    const code = instrumentJsx(source, "f.tsx", true)?.code ?? "";
    for (const tag of ["hr", "footer", "aside"]) {
      expect(code).toMatch(
        new RegExp(`<${tag} data-jesutobits-loc="[^"]+" data-jesutobits-comp="Footer"`),
      );
    }
  });

  it("does not attribute nested function returns to the outer component", () => {
    const source = "function List() { const row = () => <li />; return <ul>{row()}</ul>; }";
    const code = instrumentJsx(source, "l.jsx", false)?.code ?? "";
    expect(code).toContain('<ul data-jesutobits-loc="l.jsx:1:52" data-jesutobits-comp="List">');
    expect(code).toContain('<li data-jesutobits-loc="l.jsx:1:37" />');
  });

  it("leaves elements that already carry a location", () => {
    const source = 'const x = <div data-jesutobits-loc="keep:1:1" />;';
    expect(instrumentJsx(source, "x.jsx", false)).toBeNull();
  });

  it("uses an expression attribute for paths that are not safe in a JSX string", () => {
    const code = instrumentJsx("const x = <p />;", 'we"ird/x.jsx', false)?.code;
    expect(code).toContain('<p data-jesutobits-loc={"we\\"ird/x.jsx:1:11"} />');
  });

  it("returns null for code that does not parse", () => {
    expect(instrumentJsx("const x = <div>;", "x.jsx", false)).toBeNull();
  });

  it("maps instrumented code back to the original positions", () => {
    const result = instrumentJsx('const x = <p className="a">hi</p>;', "x.jsx", false);
    expect(result?.map.sources).toEqual(["x.jsx"]);
    expect(result?.map.mappings.length).toBeGreaterThan(0);
  });
});
