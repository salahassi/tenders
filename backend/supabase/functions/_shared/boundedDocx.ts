import type { RenderModel } from "./export.ts";
import { AppError } from "./http.ts";
import { readDocxArchiveChunks } from "./boundedDocxArchive.ts";
import { BoundedXml } from "./boundedXml.ts";
import {
  docxRunSegments,
  NATIVE_DOCX_RUN_OVERHEAD,
} from "./docxRunSegments.ts";
const normalize = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[\u200e\u200f\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
function mismatch(
  message = "Word content does not match the authorized proposal. Generate a new version for content changes.",
): never {
  throw new AppError(422, "EXPORT_CONTENT_MISMATCH", message);
}
function invalid(): never {
  throw new AppError(422, "INVALID_EXPORT_ARCHIVE", "The Word XML is invalid.");
}
const unsafe = (): never => {
  throw new AppError(
    422,
    "EXPORT_UNSAFE_CONTENT",
    "Remove tracked changes, comments and external relationships.",
  );
};
type ModelTable = Extract<RenderModel["blocks"][number], { type: "table" }>;
function tableWidth(table: ModelTable) {
  let width = table.headers.length;
  for (const row of table.rows) width = Math.max(width, row.length);
  return width;
}
function* sourceParagraphs(
  model: RenderModel,
): Generator<{ text: string; gap: boolean; heading?: boolean }> {
  const inline = (text: string) =>
    model.placeholder_version === 2 &&
    /\[INPUT REQUIRED|\[مطلوب|\[مدخل(?:ات)? مطلوب/iu.test(text);
  for (const block of model.blocks) {
    if (block.type === "table") {
      const width = tableWidth(block);
      for (let i = 0; i < width; i++) {
        const text = block.headers[i] ?? "";
        yield { text, gap: inline(text) };
      }
      for (const row of block.rows)
        for (let i = 0; i < width; i++) {
          const text = row[i] ?? "";
          yield { text, gap: inline(text) };
        }
    } else
      yield {
        text: block.text,
        gap: block.type === "placeholder" || inline(block.text),
        heading: block.type === "heading",
      };
  }
}
function* expectedParagraphs(model: RenderModel) {
  for (const paragraph of sourceParagraphs(model)) {
    const text = normalize(paragraph.text);
    if (text) yield { text, gap: paragraph.gap, heading: paragraph.heading };
  }
}
interface Paragraph {
  text: string;
  all: boolean;
  any: boolean;
  runs: number;
  bookmarks: string[];
}
interface Sdt {
  toc: boolean;
  ordinary: boolean;
  pending: Paragraph[];
}
/** Verify incrementally against authorized paragraphs. ZIP/model admission is
 * bounded separately; native XML allowance scales with actual authorized text
 * and fixed paragraph properties rather than an archive-supplied allocation. */
function* verifyChunks(
  bytes: Uint8Array,
  model: RenderModel,
  blockedContent: (value: string) => boolean,
) {
  const expected = expectedParagraphs(model);
  let expectedCount = 0,
    structuralCount = 0,
    textUnits = 0,
    nativeRuns = 0,
    longest = 0;
  for (const paragraph of sourceParagraphs(model)) {
    structuralCount++;
    if (normalize(paragraph.text)) expectedCount++;
    textUnits += paragraph.text.length;
    longest = Math.max(longest, paragraph.text.length);
    // A short mixed-script source may need one native formatting run per
    // character. Budget its exact authorized segmentation, without retaining
    // a split/run array or trusting archive-declared expansion. Yield even
    // when a single paragraph contains many alternating script runs.
    for (const _segment of docxRunSegments(paragraph.text))
      if (++nativeRuns % 4096 === 0) yield;
    if (structuralCount % 4096 === 0) yield;
  }
  const documentLimit = Math.max(
    40 * 1024 * 1024,
    8 * 1024 * 1024 +
      (structuralCount + model.blocks.length) * 2048 +
      textUnits * 12 +
      nativeRuns * NATIVE_DOCX_RUN_OVERHEAD,
  );
  if (!Number.isSafeInteger(documentLimit)) invalid();
  const paragraphLimit = Math.max(65536, longest * 8 + 8192);
  const headings = model.blocks
    .filter((b) => b.type === "heading")
    .map((b) => normalize((b as { text: string }).text));
  let hasToc = false,
    updateFields = false,
    consumed = 0;
  const relationships: string[] = [];
  // Text alone loses the position of a blank table. Anchor each table and
  // native contents field to the same canonical nonempty paragraph sequence.
  const tableAnchors: { model: ModelTable; preceding: number }[] = [];
  const tocAnchors: number[] = [];
  let preceding = 0,
    anchoredCells = 0;
  for (const block of model.blocks) {
    if (block.type === "table") {
      tableAnchors.push({ model: block, preceding });
      for (const row of [block.headers, ...block.rows])
        for (const text of row) {
          if (normalize(text)) preceding++;
          if (++anchoredCells % 4096 === 0) yield;
        }
    } else {
      if (normalize(block.text)) preceding++;
      if (block.type === "toc") tocAnchors.push(preceding);
    }
  }
  const expectedTables = tableAnchors[Symbol.iterator]();
  const expectedTocs = tocAnchors[Symbol.iterator]();
  const tocBookmarks = new Set<string>();
  const tocReferences = new Set<string>();
  const accept = (paragraph: Paragraph) => {
    const actual = normalize(paragraph.text);
    if (!actual) return;
    const next = expected.next();
    if (next.done || actual !== next.value.text) mismatch();
    if (model.placeholder_version === 1 || model.placeholder_version === 2) {
      if (
        next.value.gap ? !(paragraph.runs > 0 && paragraph.all) : paragraph.any
      )
        throw new AppError(
          422,
          "EXPORT_PLACEHOLDER_MISMATCH",
          "Every missing input must retain its yellow highlight, without marking confirmed content as missing.",
        );
    }
    if (next.value.heading)
      for (const bookmark of paragraph.bookmarks) tocBookmarks.add(bookmark);
    consumed++;
  };
  const acceptToc = (paragraph: Paragraph) => {
    const actual = normalize(paragraph.text);
    if (
      !actual ||
      actual === (model.language === "ar" ? "المحتويات" : "Contents")
    )
      return;
    if (
      !headings.some(
        (heading) =>
          actual === heading ||
          (actual.startsWith(heading) &&
            /^[ \t]*[0-9ivxlcdm]*$/i.test(actual.slice(heading.length))),
      )
    )
      mismatch("The contents table contains unapproved text.");
  };
  const names = yield* readDocxArchiveChunks(bytes, documentLimit, (entry) => {
    if (!/\.xml$|\.rels$/.test(entry.name)) return () => {};
    const document = entry.name === "word/document.xml",
      footer = /^word\/footer[0-9]*\.xml$/.test(entry.name),
      auxiliary =
        /^word\/(?:header|footer|footnotes|endnotes)[0-9]*\.xml$/.test(
          entry.name,
        ),
      core = entry.name === "docProps/core.xml";
    const stack: string[] = [],
      sdts: Sdt[] = [];
    let paragraph: Paragraph | null = null,
      run: { text: string; yellow: boolean } | null = null,
      pPr = 0,
      rPr = 0,
      instructionDepth = 0,
      partText = "",
      coreRaw = "",
      authorDepth = 0,
      authorText = "",
      root = false;
    let table: {
      model: ModelTable;
      width: number;
      grid: number;
      gridOpen: boolean;
      gridSeen: boolean;
      rows: number;
      row: string[] | null;
      cells: number;
      cell: { expected: string; text: string; paragraphs: number } | null;
    } | null = null;
    const supportedParents: Record<string, string[]> = {
      "w:body": ["w:document"],
      "w:p": document
        ? ["w:body", "w:tc", "w:sdtContent"]
        : ["w:ftr", "w:sdtContent"],
      "w:r": ["w:p", "w:hyperlink", "w:fldSimple", "w:sdtContent"],
      "w:t": ["w:r"],
      "w:tab": ["w:r", "w:tabs"],
      "w:tabs": ["w:pPr"],
      "w:br": ["w:r"],
      "w:cr": ["w:r"],
      "w:noBreakHyphen": ["w:r"],
      "w:softHyphen": ["w:r"],
      "w:instrText": ["w:r"],
      "w:fldChar": ["w:r"],
      "w:pPr": ["w:p"],
      "w:rPr": ["w:r", "w:pPr"],
      "w:highlight": ["w:rPr"],
      "w:tbl": document ? ["w:body", "w:sdtContent"] : [],
      "w:tblGrid": ["w:tbl"],
      "w:gridCol": ["w:tblGrid"],
      "w:tr": ["w:tbl"],
      "w:tc": ["w:tr"],
      "w:sdt": ["w:body", "w:p", "w:tc", "w:sdtContent"],
      "w:sdtContent": ["w:sdt"],
      "w:hyperlink": ["w:p"],
      "w:fldSimple": ["w:p", "w:hyperlink", "w:sdtContent"],
    };
    type Field = {
      simple: boolean;
      separated: boolean;
      instruction: string;
      kind?: "toc" | "page" | "toc_page" | "toc_link";
      container?: Sdt;
      result: string;
    };
    const fields: Field[] = [];
    const fieldFailure = (): never => {
      throw new AppError(
        422,
        "EXPORT_UNSAFE_CONTENT",
        "Only native contents and page-number fields are allowed in the reviewed Word file.",
      );
    };
    const markToc = () => {
      const sdt = sdts.at(-1);
      if (!document || !sdt || table || sdt.ordinary || sdt.toc) fieldFailure();
      const next = expectedTocs.next();
      if (next.done || next.value !== consumed)
        mismatch("The contents field moved from its authorized position.");
      hasToc = true;
      sdt!.toc = true;
      for (const saved of sdt!.pending) acceptToc(saved);
      sdt!.pending = [];
    };
    const checkField = (field: Field) => {
      const instruction = field.instruction.trim();
      const tokens = instruction.match(/"[^"]*"|[^\s]+/g) || [];
      const command = tokens.shift()?.toUpperCase();
      if (command === "PAGE") {
        if (
          !footer ||
          !/^(?:PAGE)(?:\s+\\\*\s+MERGEFORMAT)?$/i.test(instruction)
        )
          fieldFailure();
        field.kind = "page";
        return;
      }
      if (command === "TOC") {
        const seen = new Set<string>();
        for (let i = 0; i < tokens.length; i++) {
          const option = tokens[i].toLowerCase();
          if (seen.has(option)) fieldFailure();
          seen.add(option);
          if (["\\h", "\\z", "\\u"].includes(option)) continue;
          if (option === "\\o") {
            const range = /^"([1-9])-([1-9])"$/.exec(tokens[++i] || "");
            if (!range || range[1] > range[2]) fieldFailure();
          } else if (
            option === "\\*" &&
            tokens[++i]?.toUpperCase() === "MERGEFORMAT"
          )
            continue;
          else fieldFailure();
        }
        if (field.container !== sdts.at(-1)) fieldFailure();
        markToc();
        field.kind = "toc";
        return;
      }
      if (!document || !sdts.some((sdt) => sdt.toc)) fieldFailure();
      // Updated Word contents use only local heading bookmarks. No URL,
      // external document, arbitrary bookmark or nested dynamic code is read.
      const reference =
        command === "PAGEREF"
          ? /^PAGEREF\s+(?:"(_Toc[A-Za-z0-9_]{1,120})"|(_Toc[A-Za-z0-9_]{1,120}))(?:\s+\\h)?(?:\s+\\\*\s+MERGEFORMAT)?$/i.exec(
              instruction,
            )
          : command === "HYPERLINK"
            ? /^HYPERLINK\s+\\l\s+(?:"(_Toc[A-Za-z0-9_]{1,120})"|(_Toc[A-Za-z0-9_]{1,120}))(?:\s+\\\*\s+MERGEFORMAT)?$/i.exec(
                instruction,
              )
            : null;
      if (!reference) fieldFailure();
      field.kind = command === "PAGEREF" ? "toc_page" : "toc_link";
      tocReferences.add(reference![1] || reference![2]);
      if (tocReferences.size > 4096) invalid();
    };
    const finishField = (field: Field) => {
      if (!field.separated) checkField(field);
      if (
        (field.kind === "page" && !/^[0-9]*$/.test(normalize(field.result))) ||
        (field.kind === "toc_page" &&
          !/^[0-9ivxlcdm]*$/i.test(normalize(field.result)))
      )
        fieldFailure();
    };
    const canNestField = () => {
      const parent = fields.at(-1);
      if (
        fields.length >= 128 ||
        (parent &&
          (!parent.separated ||
            !["toc", "toc_link"].includes(parent.kind || "")))
      )
        fieldFailure();
    };
    const append = (value: string) => {
      if (pPr || rPr) return;
      const field = fields.at(-1);
      if (field && !field.separated) fieldFailure();
      if (field && (field.kind === "page" || field.kind === "toc_page")) {
        field.result += value;
        if (field.result.length > 128) fieldFailure();
      }
      if (document && paragraph) {
        paragraph.text += value;
        if (paragraph.text.length > paragraphLimit) mismatch();
        if (run) {
          run.text += value;
          if (run.text.length > paragraphLimit) mismatch();
        }
      }
      if (auxiliary) {
        partText += value;
        if (partText.length > Math.max(65536, model.footer.length * 8 + 8192))
          mismatch();
      }
    };
    const parser = new BoundedXml({
      start(tag, attributes) {
        if (!root) {
          root = true;
          if (
            (document && tag !== "w:document") ||
            (entry.name === "word/settings.xml" && tag !== "w:settings")
          )
            invalid();
        }
        if (
          /^w:(?:ins|del|commentRangeStart|commentRangeEnd|commentReference)$/.test(
            tag,
          ) ||
          (/comments\d*\.xml$/i.test(entry.name) && tag === "w:comment") ||
          attributes.TargetMode?.toLowerCase() === "external"
        )
          unsafe();
        if (
          [
            "w:altChunk",
            "w:object",
            "w:drawing",
            "w:pict",
            "w:txbxContent",
            "w:subDoc",
            "w:sym",
          ].includes(tag)
        )
          unsafe();
        if (document || footer) {
          // Supported native/reviewed shapes, not full OOXML schema validation.
          // Word may ignore foreign/undefined wrappers: their text, properties
          // and field tokens must never satisfy this verifier's visible oracle.
          if (
            supportedParents[tag] &&
            !supportedParents[tag].includes(stack.at(-1) || "")
          )
            invalid();
          if (tag === "w:r" && !stack.includes("w:p")) invalid();
        }
        if (
          ["w:vanish", "w:webHidden", "w:specVanish"].includes(tag) &&
          !["false", "0", "off"].includes(attributes["w:val"]?.toLowerCase())
        )
          throw new AppError(
            422,
            "EXPORT_UNSAFE_CONTENT",
            "Authorized Word content must remain visible.",
          );
        if (tag === "w:fldChar") {
          const kind = attributes["w:fldCharType"];
          if ((!document && !footer) || stack.at(-1) !== "w:r") fieldFailure();
          if (kind === "begin") {
            canNestField();
            fields.push({
              simple: false,
              separated: false,
              instruction: "",
              container: sdts.at(-1),
              result: "",
            });
          } else if (kind === "separate") {
            const field = fields.at(-1);
            if (!field || field.simple || field.separated) fieldFailure();
            checkField(field!);
            field!.separated = true;
          } else if (kind === "end") {
            const field = fields.pop();
            if (!field || field.simple) fieldFailure();
            finishField(field!);
          } else fieldFailure();
        }
        if (tag === "w:fldSimple") {
          canNestField();
          const field: Field = {
            simple: true,
            separated: true,
            instruction: attributes["w:instr"] || "",
            container: sdts.at(-1),
            result: "",
          };
          checkField(field);
          fields.push(field);
        }
        if (
          tag === "w:bookmarkStart" &&
          document &&
          paragraph &&
          attributes["w:name"]
        )
          paragraph.bookmarks.push(attributes["w:name"]);
        if (
          entry.name.endsWith(".rels") &&
          tag === "Relationship" &&
          attributes.Target
        ) {
          const target = attributes.Target;
          if (/^[A-Za-z][A-Za-z0-9+.-]*:|[\\\x00]/.test(target)) unsafe();
          const base =
            entry.name === "_rels/.rels"
              ? ""
              : entry.name.slice(0, entry.name.lastIndexOf("/_rels/") + 1);
          const resolved: string[] = [];
          for (const segment of (target.startsWith("/")
            ? target.slice(1)
            : base + target
          ).split("/")) {
            if (!segment || segment === ".") continue;
            if (segment === "..") {
              if (!resolved.length) invalid();
              resolved.pop();
            } else resolved.push(segment);
          }
          relationships.push(resolved.join("/"));
          if (relationships.length > 4096) invalid();
        }
        if (entry.name === "word/settings.xml" && tag === "w:updateFields") {
          if (![undefined, "true", "1", "on"].includes(attributes["w:val"]))
            throw new AppError(
              422,
              "EXPORT_FIELDS_MISSING",
              "The Word file must retain enabled update-fields settings.",
            );
          updateFields = true;
        }
        if (core && (tag === "dc:creator" || tag === "cp:lastModifiedBy")) {
          authorDepth = stack.length + 1;
          authorText = "";
        }
        if (document && tag === "w:tbl") {
          const next = expectedTables.next();
          if (
            table ||
            next.done ||
            next.value.preceding !== consumed ||
            sdts.some((sdt) => sdt.toc)
          )
            mismatch(
              "The Word table structure does not match the authorized proposal.",
            );
          table = {
            model: next.value!.model,
            width: tableWidth(next.value!.model),
            grid: 0,
            gridOpen: false,
            gridSeen: false,
            rows: 0,
            row: null,
            cells: 0,
            cell: null,
          };
        }
        if (document && tag === "w:tblGrid") {
          if (!table || table.gridSeen)
            mismatch(
              "The Word table grid does not match the authorized proposal.",
            );
          table!.gridOpen = true;
          table!.gridSeen = true;
        }
        if (document && tag === "w:gridCol") {
          if (!table?.gridOpen) mismatch("The Word table grid is invalid.");
          table!.grid++;
        }
        if (document && tag === "w:gridSpan" && attributes["w:val"] !== "1")
          mismatch("The Word table uses unauthorized merged cells.");
        if (document && tag === "w:vMerge")
          mismatch("The Word table uses unauthorized merged cells.");
        if (document && tag === "w:tr") {
          if (!table || table.row || table.rows > table.model.rows.length)
            mismatch(
              "The Word table row count does not match the authorized proposal.",
            );
          table!.row =
            table!.rows === 0
              ? table!.model.headers
              : table!.model.rows[table!.rows - 1];
          table!.cells = 0;
        }
        if (document && tag === "w:tc") {
          if (!table?.row || table.cell || table.cells >= table.width)
            mismatch(
              "The Word table cell count does not match the authorized proposal.",
            );
          table!.cell = {
            expected: normalize(table!.row![table!.cells] ?? ""),
            text: "",
            paragraphs: 0,
          };
        }
        if (document && tag === "w:sdt")
          sdts.push({ toc: false, ordinary: false, pending: [] });
        if (document && tag === "w:p") {
          if (paragraph) invalid();
          if (table && !table.cell)
            mismatch("A Word table paragraph is outside its authorized cell.");
          if (table?.cell) table.cell.paragraphs++;
          paragraph = {
            text: "",
            all: true,
            any: false,
            runs: 0,
            bookmarks: [],
          };
        }
        if (tag === "w:pPr") pPr++;
        if (tag === "w:rPr") rPr++;
        if (document && tag === "w:r") {
          if (run) invalid();
          run = { text: "", yellow: false };
        }
        if (
          run &&
          rPr &&
          tag === "w:highlight" &&
          attributes["w:val"] === "yellow"
        )
          run.yellow = true;
        if (tag === "w:instrText") {
          const field = fields.at(-1);
          if (instructionDepth || !field || field.simple || field.separated)
            fieldFailure();
          instructionDepth = stack.length + 1;
        }
        if (tag === "w:tab") append("\t");
        if (tag === "w:br" || tag === "w:cr") append("\n");
        if (tag === "w:noBreakHyphen") append("\u2011");
        if (tag === "w:softHyphen") append("\u00ad");
        stack.push(tag);
      },
      text(value) {
        if (authorDepth) authorText += value;
        if (instructionDepth) {
          const field = fields.at(-1)!;
          field.instruction += value;
          if (field.instruction.length > 65536) invalid();
          return;
        }
        if (stack.at(-1) === "w:t") append(value);
      },
      end(tag) {
        if (authorDepth === stack.length) {
          if (authorText && authorText !== "Tenderdesk")
            throw new AppError(
              422,
              "EXPORT_METADATA_REVIEW_REQUIRED",
              "Remove personal author properties before uploading the reviewed file.",
            );
          authorDepth = 0;
        }
        if (stack.pop() !== tag) invalid();
        if (tag === "w:instrText") instructionDepth = 0;
        if (tag === "w:fldSimple") {
          const field = fields.pop();
          if (!field?.simple) fieldFailure();
          finishField(field!);
        }
        if (tag === "w:p" && footer && fields.length) fieldFailure();
        if (tag === "w:r" && document && run) {
          if (normalize(run.text) && paragraph) {
            paragraph.runs++;
            paragraph.all &&= run.yellow;
            paragraph.any ||= run.yellow;
          }
          run = null;
        }
        if (tag === "w:p" && document && paragraph) {
          if (table?.cell) {
            table.cell.text += paragraph.text + "\n";
            if (table.cell.text.length > paragraphLimit) mismatch();
          }
          const sdt = sdts.at(-1);
          if (!sdt || sdt.ordinary) accept(paragraph);
          else if (sdt.toc) acceptToc(paragraph);
          else {
            const text = normalize(paragraph.text);
            if (
              text &&
              text !== (model.language === "ar" ? "المحتويات" : "Contents")
            ) {
              sdt.ordinary = true;
              for (const saved of sdt.pending) accept(saved);
              sdt.pending = [];
              accept(paragraph);
            } else {
              sdt.pending.push(paragraph);
              if (sdt.pending.length > 8) invalid();
            }
          }
          paragraph = null;
        }
        if (tag === "w:tblGrid" && document) {
          if (!table?.gridOpen || table.grid !== table.width)
            mismatch(
              "The Word table grid does not match the authorized proposal.",
            );
          table!.gridOpen = false;
        }
        if (tag === "w:tc" && document) {
          if (
            !table?.cell ||
            !table.cell.paragraphs ||
            normalize(table.cell.text) !== table.cell.expected
          )
            mismatch(
              "The Word table cell content does not match the authorized proposal.",
            );
          table!.cell = null;
          table!.cells++;
        }
        if (tag === "w:tr" && document) {
          if (!table?.row || table.cell || table.cells !== table.width)
            mismatch(
              "The Word table row structure does not match the authorized proposal.",
            );
          table!.row = null;
          table!.rows++;
        }
        if (tag === "w:tbl" && document) {
          if (
            !table ||
            table.row ||
            table.rows !== table.model.rows.length + 1 ||
            !table.gridSeen ||
            table.gridOpen
          )
            mismatch(
              "The Word table structure does not match the authorized proposal.",
            );
          table = null;
        }
        if (tag === "w:sdt" && document) {
          if (fields.some((field) => field.container === sdts.at(-1)))
            fieldFailure();
          const sdt = sdts.pop();
          if (!sdt) invalid();
          for (const saved of sdt.pending)
            (sdt.toc ? acceptToc : accept)(saved);
        }
        if (tag === "w:pPr") pPr--;
        if (tag === "w:rPr") rPr--;
      },
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return (chunk, final) => {
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: !final });
      } catch {
        invalid();
      }
      if (core) {
        coreRaw += text!;
        if (coreRaw.length > 4 * 1024 * 1024) invalid();
      }
      parser.push(text!, final);
      if (!final) return;
      if (fields.length || instructionDepth) invalid();
      if (document && (paragraph || run || sdts.length || table)) invalid();
      if (auxiliary) {
        const actual = normalize(partText),
          expected = normalize(model.footer);
        if (footer) {
          if (
            actual !== expected &&
            actual !== normalize(expected + " ·") &&
            !(
              actual.startsWith(expected) &&
              /^(?: · )?[0-9]*$/.test(actual.slice(expected.length))
            )
          )
            mismatch("Unexpected footer content.");
        } else if (actual) mismatch("Unexpected header or note content.");
      }
      if (
        core &&
        (blockedContent(coreRaw) ||
          /<(?:dc:creator|cp:lastModifiedBy)>(?!Tenderdesk<)[^<]+</.test(
            coreRaw,
          ))
      )
        throw new AppError(
          422,
          "EXPORT_METADATA_REVIEW_REQUIRED",
          "Remove personal author properties before uploading the reviewed file.",
        );
    };
  });
  if (
    consumed !== expectedCount ||
    !expected.next().done ||
    !expectedTables.next().done ||
    !expectedTocs.next().done
  )
    mismatch();
  if (!updateFields || !hasToc)
    throw new AppError(
      422,
      "EXPORT_FIELDS_MISSING",
      "The Word file must retain live contents and update-fields settings.",
    );
  for (const reference of tocReferences)
    if (!tocBookmarks.has(reference))
      mismatch(
        "The contents field references an unauthorized heading bookmark.",
      );
  for (const target of relationships) if (!names.has(target)) invalid();
  return true;
}

export function verifyBoundedDocx(
  bytes: Uint8Array,
  model: RenderModel,
  policy: (text: string) => boolean,
) {
  const chunks = verifyChunks(bytes, model, policy);
  for (;;) {
    const next = chunks.next();
    if (next.done) return next.value;
  }
}
/** Identical acceptance rules; let queued requests/cancellation run during a
 * large scan instead of monopolizing the API/worker event loop. */
export async function verifyBoundedDocxAsync(
  bytes: Uint8Array,
  model: RenderModel,
  policy: (text: string) => boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const chunks = verifyChunks(bytes, model, policy);
  let lastYield = performance.now();
  try {
    for (;;) {
      const next = chunks.next();
      if (next.done) return next.value;
      if (performance.now() - lastYield >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
        lastYield = performance.now();
      }
    }
  } finally {
    chunks.return(true);
  }
}
