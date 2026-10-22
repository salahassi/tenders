import { load } from "cheerio";

/** Bounded public DOM for configured extraction; never rendered by the app. */
export function sourcePageMarkup(html: string): string | undefined {
  const $ = load(html);
  $(
    "script,style,noscript,template,input,textarea,button,select,option,iframe,object,embed,svg,canvas,header,footer,nav",
  ).remove();
  // Login dialogs are not tender evidence. The browser checks visible login
  // walls before this function; removing their controls must not retain labels.
  $(".modal,[role=dialog]").remove();
  $("*").each((_, node) => {
    if (!("attribs" in node)) return;
    const element = $(node);
    for (const attribute of Object.keys(node.attribs)) {
      if (
        !["class", "id", "href", "title", "lang", "dir"].includes(attribute) &&
        !/^data-(?:id|ref|key|code|number|status)$/.test(attribute)
      )
        element.removeAttr(attribute);
    }
    element
      .contents()
      .filter((_, child) => child.type === "comment")
      .remove();
  });
  const markup = `<body>${$("body").html() || ""}</body>`;
  return new TextEncoder().encode(markup).byteLength <= 180000
    ? markup
    : undefined;
}

/** Keep the full saved-page envelope within its existing SQL byte boundary. */
export function withSourceMarkup<T extends object>(page: T, html: string) {
  const extraction_html = sourcePageMarkup(html);
  if (!extraction_html) return page;
  const result = { ...page, extraction_html };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 250000
    ? result
    : page;
}
