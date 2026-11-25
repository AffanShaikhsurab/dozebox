// A small reader for the part of HCL the module's `variable` and `output` blocks use: attributes, nested blocks,
// strings with `${}` interpolation and brackets that span lines. It is not a general HCL parser.

type HclItem =
  | { readonly kind: "attr"; readonly name: string; readonly value: string }
  | { readonly kind: "block"; readonly name: string; readonly body: string };

export type HclDeclaration = {
  readonly kind: "variable" | "output";
  readonly name: string;
  readonly items: ReadonlyArray<HclItem>;
};

function lineEnd(text: string, from: number): number {
  const at = text.indexOf("\n", from);
  return at === -1 ? text.length : at;
}

function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else if ((c === "$" || c === "%") && text[i + 1] === "{") i = skipBraces(text, i + 1);
    else i++;
  }
  return text.length;
}

/** The index after the `}` that closes the `{` at `open`. */
function skipBraces(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') i = skipString(text, i);
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) i = lineEnd(text, i);
    else {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i + 1;
      i++;
    }
  }
  return text.length;
}

/** The end of an attribute value that starts at `start`: the first newline with every bracket closed. */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let commentAt = -1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') i = skipString(text, i);
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      if (commentAt === -1) commentAt = i;
      i = lineEnd(text, i);
    } else if (c === "\n" && depth <= 0) break;
    else {
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      if (c === "\n") commentAt = -1;
      i++;
    }
  }
  return commentAt === -1 ? i : commentAt;
}

/** The attributes and blocks at the top level of one block body. */
function items(body: string): ReadonlyArray<HclItem> {
  const out: HclItem[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "#" || (c === "/" && body[i + 1] === "/")) i = lineEnd(body, i);
    else {
      const name = /^[A-Za-z_][\w-]*/.exec(body.slice(i))?.[0];
      if (name === undefined) {
        i++;
        continue;
      }
      i += name.length;
      while (body[i] === " " || body[i] === "\t") i++;
      if (body[i] === "=") {
        const end = valueEnd(body, i + 1);
        out.push({ kind: "attr", name, value: body.slice(i + 1, end).trim() });
        i = end;
      } else if (body[i] === "{") {
        const end = skipBraces(body, i);
        out.push({ kind: "block", name, body: body.slice(i + 1, end - 1) });
        i = end;
      } else i = lineEnd(body, i);
    }
  }
  return out;
}

/** Every top-level `variable "x" {` and `output "x" {` of one file, in file order. */
export function declarations(text: string): ReadonlyArray<HclDeclaration> {
  const out: HclDeclaration[] = [];
  for (const m of text.matchAll(/^(variable|output)\s+"([^"]+)"\s*\{/gm)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const end = skipBraces(text, open);
    out.push({
      kind: m[1] === "variable" ? "variable" : "output",
      name: m[2] ?? "",
      items: items(text.slice(open + 1, end - 1)),
    });
  }
  return out;
}

/** The text of a quoted HCL string, or the value as written when it is not one. */
export function stringValue(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}
