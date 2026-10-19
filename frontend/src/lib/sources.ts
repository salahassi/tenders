import type { Source } from "../types";

// External manual portals have a URL; they must never become the origin of
// unrelated opportunities that the user enters or imports directly.
export const isBuiltInSource = (source: Source) =>
  source.type === "manual" && !source.url;

export const canCollectSource = (source: Source) =>
  source.type !== "manual" && !source.adapterRequired;

export const sourceCountry = (source: Source) =>
  source.tags.find((tag) => /^country:[A-Z]{2}$/.test(tag))?.slice(8);
