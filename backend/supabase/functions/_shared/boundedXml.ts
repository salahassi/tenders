import { AppError } from "./http.ts";
function fail(): never {
  throw new AppError(422, "INVALID_EXPORT_ARCHIVE", "The Word XML is invalid.");
}
const unsafe = (): never => {
  throw new AppError(
    422,
    "EXPORT_UNSAFE_CONTENT",
    "Remove tracked changes, comments and external relationships.",
  );
};
const name = /^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
export function xmlValue(raw: string): string {
  if (controls.test(raw)) fail();
  return raw.replace(/&([^;]*);|&/g, (match, entity: string | undefined) => {
    if (entity === undefined) return fail();
    const known: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (Object.hasOwn(known, entity)) return known[entity];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) return fail();
    const cp =
      entity[1] === "x"
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    if (
      !Number.isSafeInteger(cp) ||
      cp > 0x10ffff ||
      (cp < 0x20 && ![9, 10, 13].includes(cp)) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      (cp & 0xffff) >= 0xfffe
    )
      return fail();
    return String.fromCodePoint(cp);
  });
}
export interface XmlEvents {
  start(name: string, attributes: Readonly<Record<string, string>>): void;
  text(value: string): void;
  end(name: string): void;
}
/** Small strict XML tokenizer. It retains at most one bounded tag or text tail,
 * never a DOM. XML declarations, comments and CDATA remain well-formed; DTD and
 * entities outside the five predefined/numeric forms are forbidden. */
export class BoundedXml {
  private buffer = "";
  private stack: string[] = [];
  private canonical: string[] = [];
  private resolved = new WeakMap<
    object,
    {
      namespace: Record<string, string>;
      tag: string;
      attributes: Record<string, string>;
    }
  >();
  private namespaces: Record<string, string>[] = [];
  private root = false;
  private finished = false;
  private declaration = false;
  private cdata = false;
  private cache = new Map<
    string,
    { tag: string; attributes: Record<string, string>; self: boolean }
  >();
  constructor(private readonly events: XmlEvents) {}
  push(chunk: string, final: boolean) {
    if (this.finished) fail();
    this.buffer += chunk;
    while (this.buffer.length) {
      if (this.cdata) {
        const end = this.buffer.indexOf("]]>");
        if (end < 0) {
          if (final) fail();
          if (this.buffer.length > 2) {
            this.characters(this.buffer.slice(0, -2), false);
            this.buffer = this.buffer.slice(-2);
          }
          break;
        }
        this.characters(this.buffer.slice(0, end), false);
        this.buffer = this.buffer.slice(end + 3);
        this.cdata = false;
        continue;
      }
      if (this.buffer[0] !== "<") {
        let end = this.buffer.indexOf("<");
        if (end < 0) {
          if (!final) {
            end = Math.max(0, this.buffer.length - 2);
            const amp = this.buffer.lastIndexOf("&");
            if (
              amp >= 0 &&
              (this.buffer.indexOf(";", amp) < 0 ||
                this.buffer.indexOf(";", amp) >= end)
            ) {
              if (this.buffer.length - amp > 32) fail();
              end = Math.min(end, amp);
            }
            if (!end) break;
          } else end = this.buffer.length;
        }
        const value = this.buffer.slice(0, end);
        if (value.includes("]]>")) fail();
        this.characters(value, true);
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (this.buffer.startsWith("<!--")) {
        const end = this.buffer.indexOf("-->");
        if (end < 0) {
          if (this.buffer.length > 65536 || final) fail();
          break;
        }
        if (
          this.buffer.slice(4, end).includes("--") ||
          controls.test(this.buffer.slice(4, end))
        )
          fail();
        this.buffer = this.buffer.slice(end + 3);
        continue;
      }
      if (this.buffer.startsWith("<![CDATA[")) {
        if (!this.stack.length) fail();
        this.cdata = true;
        this.buffer = this.buffer.slice(9);
        continue;
      }
      if (/^<!DOCTYPE|^<!ENTITY/i.test(this.buffer)) unsafe();
      if (this.buffer.startsWith("<?")) {
        const end = this.buffer.indexOf("?>");
        if (end < 0) {
          if (this.buffer.length > 1024 || final) fail();
          break;
        }
        const instruction = this.buffer.slice(2, end);
        if (
          this.root ||
          this.declaration ||
          !/^xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*$/i.test(
            instruction,
          )
        )
          fail();
        this.declaration = true;
        this.buffer = this.buffer.slice(end + 2);
        continue;
      }
      // A quote-aware end scan prevents an attribute's literal '>' from ending
      // a tag early. Native OOXML tags are small; huge attributes fail closed.
      let quote = "",
        end = -1;
      for (let i = 1; i < this.buffer.length; i++) {
        const char = this.buffer[i];
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") {
          end = i;
          break;
        } else if (char === "<") fail();
      }
      if (end < 0) {
        if (this.buffer.length > 65536 || final) fail();
        break;
      }
      if (end > 65536) fail();
      const token = this.buffer.slice(1, end);
      this.buffer = this.buffer.slice(end + 1);
      if (token[0] === "/") {
        if (/^\s/.test(token.slice(1))) fail();
        const tag = token.slice(1).trimEnd();
        if (!name.test(tag) || this.stack.pop() !== tag) fail();
        this.events.end(this.canonical.pop()!);
        this.namespaces.pop();
        continue;
      }
      if (token[0] === "!") unsafe();
      let parsed = this.cache.get(token);
      if (!parsed) {
        const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(token);
        if (!match) fail();
        const tag = match[1],
          self = /\/\s*$/.test(match[2]);
        let rest = self ? match[2].replace(/\/\s*$/, "") : match[2];
        if (!name.test(tag) || tag.startsWith("xmlns:")) fail();
        const attributes: Record<string, string> = Object.create(null);
        while (rest.length) {
          if (!/^\s/.test(rest)) fail();
          rest = rest.trimStart();
          if (!rest) break;
          const attr =
            /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(['"])([\s\S]*?)\2/.exec(rest);
          if (
            !attr ||
            !name.test(attr[1]) ||
            Object.hasOwn(attributes, attr[1]) ||
            attr[3].includes("<")
          )
            fail();
          attributes[attr[1]] = xmlValue(attr[3]);
          rest = rest.slice(attr[0].length);
          if (Object.keys(attributes).length > 128) fail();
        }
        parsed = { tag, attributes, self };
        if (this.cache.size < 256) this.cache.set(token, parsed);
      }
      const { tag, attributes, self } = parsed;
      if (!this.stack.length) {
        if (this.root) fail();
        this.root = true;
      }
      if (this.stack.length >= 128) fail();
      let ns = this.namespaces.at(-1) || {
        xml: "http://www.w3.org/XML/1998/namespace",
      };
      const declarations = Object.entries(attributes).filter(
        ([key]) => key === "xmlns" || key.startsWith("xmlns:"),
      );
      if (declarations.length) {
        ns = { ...ns };
        for (const [key, value] of declarations) {
          const prefix = key === "xmlns" ? "" : key.slice(6);
          if (
            prefix === "xmlns" ||
            (prefix && !value) ||
            value === "http://www.w3.org/2000/xmlns/" ||
            (value === "http://www.w3.org/XML/1998/namespace" &&
              prefix !== "xml")
          )
            fail();
          ns[prefix] = value;
        }
      }
      const check = (key: string) => {
        const colon = key.indexOf(":");
        if (
          colon > 0 &&
          key.slice(0, colon) !== "xmlns" &&
          !ns[key.slice(0, colon)]
        )
          fail();
      };
      check(tag);
      for (const key of Object.keys(attributes)) check(key);
      if (
        ns.w &&
        ns.w !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      )
        fail();
      if (ns.xml !== "http://www.w3.org/XML/1998/namespace") fail();
      let resolved = this.resolved.get(parsed);
      if (!resolved || resolved.namespace !== ns) {
        const known: Record<string, string> = {
          "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w:",
          "http://schemas.openxmlformats.org/package/2006/relationships": "",
          "http://www.w3.org/XML/1998/namespace": "xml:",
          "http://purl.org/dc/elements/1.1/": "dc:",
          "http://schemas.openxmlformats.org/package/2006/metadata/core-properties":
            "cp:",
        };
        const expand = (key: string, attribute: boolean) => {
          if (key === "xmlns" || key.startsWith("xmlns:")) return key;
          const colon = key.indexOf(":"),
            prefix = colon < 0 ? "" : key.slice(0, colon),
            local = colon < 0 ? key : key.slice(colon + 1);
          const uri = colon < 0 && attribute ? "" : ns[prefix] || "";
          return uri
            ? Object.hasOwn(known, uri)
              ? known[uri] + local
              : `{${uri}}${local}`
            : local;
        };
        const mapped: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(attributes)) {
          const expanded = expand(key, true);
          if (Object.hasOwn(mapped, expanded)) fail();
          mapped[expanded] = value;
        }
        resolved = {
          namespace: ns,
          tag: expand(tag, false),
          attributes: mapped,
        };
        this.resolved.set(parsed, resolved);
      }
      this.stack.push(tag);
      this.canonical.push(resolved.tag);
      this.namespaces.push(ns);
      this.events.start(resolved.tag, resolved.attributes);
      if (self) {
        this.events.end(resolved.tag);
        this.stack.pop();
        this.canonical.pop();
        this.namespaces.pop();
      }
    }
    if (final) {
      if (this.buffer || this.stack.length || !this.root || this.cdata) fail();
      this.finished = true;
    }
  }
  private characters(value: string, entities: boolean) {
    if (controls.test(value)) fail();
    const text = entities ? xmlValue(value) : value;
    if (!this.stack.length) {
      if (text.trim()) fail();
      return;
    }
    this.events.text(text);
  }
}
