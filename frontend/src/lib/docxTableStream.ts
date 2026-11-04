import { unzipSync, Zip, ZipDeflate } from "fflate";
import type { IXmlableObject } from "docx";

export interface StreamedTable {
  marker: string;
  xml(): Iterable<string>;
}

const escapeXml = (value: unknown) =>
  String(value).replace(
    /[&"'<>]/g,
    (character) =>
      ({
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
        "<": "&lt;",
        ">": "&gt;",
      })[character]!,
  );

/** Serialize only the bounded XML object produced by docx for one native row or paragraph.
 * Attribute names and element names come from docx, never source text. This
 * intentionally accepts no raw XML, declarations, CDATA or extension objects. */
export function nativeTableXml(node: IXmlableObject): string {
  const entries = Object.entries(node);
  if (entries.length !== 1) throw Error("Invalid native table XML node");
  const [name, value] = entries[0];
  if (!/^w:[A-Za-z][A-Za-z0-9]*$/.test(name))
    throw Error("Unexpected native table XML element");
  const children = Array.isArray(value) ? value : [value];
  let attributes = "",
    content = "",
    hasContent = false;
  for (const child of children) {
    if (child && typeof child === "object") {
      if ("_attr" in child) {
        if (Object.keys(child).length !== 1)
          throw Error("Invalid native XML attributes");
        for (const [key, attribute] of Object.entries(child._attr)) {
          if (!/^(?:w|xml):[A-Za-z][A-Za-z0-9]*$/.test(key))
            throw Error("Unexpected native table XML attribute");
          attributes += ` ${key}="${escapeXml(attribute)}"`;
        }
      } else if (Object.keys(child).length) {
        content += nativeTableXml(child);
        hasContent = true;
      }
    } else if (child !== null && child !== undefined) {
      content += escapeXml(child);
      hasContent = true;
    }
  }
  return hasContent
    ? `<${name}${attributes}>${content}</${name}>`
    : `<${name}${attributes}/>`;
}

/** A small docx-generated skeleton retains native fields, styles and fonts.
 * Feed native table rows and prepared paragraphs directly into ZIP compression instead of retaining a
 * document-sized cell object graph and inflated document XML string together. */
export async function packStreamedTables(
  skeleton: Blob,
  tables: StreamedTable[],
): Promise<Blob> {
  if (!tables.length) return skeleton;
  const files = unzipSync(new Uint8Array(await skeleton.arrayBuffer()));
  const document = new TextDecoder("utf-8", { fatal: true }).decode(
    files["word/document.xml"],
  );
  const encoded = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let failure: Error | undefined,
    finished = false;
  const zip = new Zip((error, bytes, final) => {
    if (error) failure = error;
    else chunks.push(bytes);
    finished ||= final;
  });
  for (const [name, bytes] of Object.entries(files)) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    if (name !== "word/document.xml") entry.push(bytes, true);
    else {
      let position = 0;
      for (const table of tables) {
        const marker = `<w:p><w:r><w:t xml:space="preserve">${table.marker}</w:t></w:r></w:p>`;
        const index = document.indexOf(marker, position);
        if (index < 0 || document.indexOf(marker, index + marker.length) >= 0)
          throw Error("Native table slot is missing or duplicated");
        entry.push(encoded.encode(document.slice(position, index)));
        for (const fragment of table.xml())
          entry.push(encoded.encode(fragment));
        position = index + marker.length;
      }
      entry.push(encoded.encode(document.slice(position)), true);
    }
    if (failure) throw failure;
  }
  zip.end();
  if (failure) throw failure;
  if (!finished) throw Error("Native table archive did not finish");
  return new Blob(chunks as BlobPart[], { type: skeleton.type });
}
