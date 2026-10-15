type Node = {
  type: string;
  value?: string;
  children?: Node[];
  styleName?: string;
  styleId?: string;
  notes?: { _notes?: Record<string, Node> };
  comments?: Node[];
};
// Read only Mammoth's bounded document AST; no source HTML, links or image bytes are rendered.
export function structuredDocxText(document: Node): string {
  const blocks: string[] = [];
  let paragraph = 0,
    table = 0,
    chars = 0;
  const add = (value: string) => {
    chars += value.length;
    if (chars > 1000000)
      throw Error(
        "Extracted content exceeds the 1,000,000-character trial limit.",
      );
    blocks.push(value);
  };
  function inline(n: Node): string {
    if (n.type === "text") return n.value || "";
    if (n.type === "tab") return "\t";
    if (n.type === "break") return "\n";
    if (n.type === "image") return "[Image: inspect the original]";
    return (n.children || []).map(inline).join("");
  }
  function walk(n: Node, prefix = "") {
    if (n.type === "table") {
      const number = ++table;
      (n.children || []).forEach((row, r) =>
        (row.children || []).forEach((cell, c) =>
          (cell.children || []).forEach((child) =>
            walk(child, `Table ${number}, row ${r + 1}, cell ${c + 1}`),
          ),
        ),
      );
      return;
    }
    if (n.type === "paragraph") {
      const body = inline(n).trim();
      if (!body) return;
      paragraph++;
      const heading = (n.styleName || n.styleId || "").match(
        /^(?:heading|عنوان)\s*(\d+)/i,
      );
      add(
        `[${prefix ? prefix + "; " : ""}${heading ? `Heading ${heading[1]}` : `Paragraph ${paragraph}`}]\n${body}`,
      );
      return;
    }
    for (const child of n.children || []) walk(child, prefix);
  }
  walk(document);
  for (const note of Object.values(document.notes?._notes || {}))
    walk(note, "Note");
  for (const comment of document.comments || []) walk(comment, "Comment");
  return blocks.join("\n\n");
}
