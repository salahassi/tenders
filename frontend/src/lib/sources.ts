import type { Source } from "../types";

// External manual portals have a URL; they must never become the origin of
// unrelated opportunities that the user enters or imports directly.
export const isBuiltInSource = (source: Source) =>
  source.type === "manual" && !source.url;

export const canCollectSource = (source: Source) =>
  !isBuiltInSource(source) && source.url.startsWith("https://");

export const sourceCountry = (source: Source) =>
  source.tags.find((tag) => /^country:[A-Z]{2}$/.test(tag))?.slice(8);

export function sourceSetupGuidance(source: Source): string | null {
  if (isBuiltInSource(source) || canCollectSource(source)) return null;
  const catalog = source.adapterConfig?.catalog;
  const entryType =
    catalog && typeof catalog === "object" && "entry_type" in catalog
      ? catalog.entry_type
      : null;
  if (entryType === "supplier_registration")
    return "This link is a supplier registration portal. Collection needs a public tender listing or an authorized integration; registration alone does not provide a tender feed.";
  if (entryType === "central_redirect")
    return "This page refers you to a central procurement platform. Connect the platform's tender listing or feed before enabling collection.";
  if (source.adapterConfig?.extraction)
    return "Saved website extraction settings are available. Review the collection method, permitted hosts and access notes, save the settings, then enable the source.";
  if (entryType === "central_platform")
    return "This procurement platform has no collection connection configured. A supported public listing, feed or authorized integration is required.";
  return "This source has no collection connection configured. Set up a working feed or website extraction settings before enabling it.";
}
