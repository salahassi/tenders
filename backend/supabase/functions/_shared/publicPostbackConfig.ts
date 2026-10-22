import { load } from "cheerio";
import { z } from "zod";
import { safeUrl } from "./contracts.ts";

const selector = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => {
    try {
      load("")(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid CSS selector");

// An observed public detail-navigation form, never arbitrary form submission.
export const publicPostbackSchema = z
  .object({
    url: safeUrl,
    rows: selector,
    title: selector,
    reference: selector.optional(),
    link: selector,
  })
  .strict();

export type PublicPostbackConfig = z.infer<typeof publicPostbackSchema>;
