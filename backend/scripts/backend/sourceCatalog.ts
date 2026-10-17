import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { safeUrl, uuid } from "../../supabase/functions/_shared/contracts.ts";

export const catalogSchema = z
  .object({
    schema_version: z.literal(1),
    catalog_version: z.iso.date(),
    sources: z
      .array(
        z
          .object({
            key: z.string().regex(/^(sa|jo|ps)-[a-z0-9-]+$/),
            country: z.enum(["SA", "JO", "PS"]),
            name: z.string().min(1).max(200),
            name_en: z.string().min(1).max(200),
            sector: z.enum([
              "government",
              "ministry",
              "bank",
              "state_owned",
              "large_company",
              "development_fund",
              "municipality",
              "university",
            ]),
            entry_type: z.enum([
              "central_platform",
              "central_redirect",
              "supplier_registration",
              "public_tenders",
            ]),
            url: safeUrl,
            evidence_url: safeUrl,
            checked_at: z.iso.date(),
            http_status: z.number().int().min(100).max(599).nullable(),
            access_note: z.string().min(1).max(3000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const keys = new Set<string>(),
      urls = new Set<string>();
    catalog.sources.forEach((source, index) => {
      const url = new URL(source.url).href.replace(/\/$/, "");
      if (
        keys.has(source.key) ||
        urls.has(url) ||
        !source.key.startsWith(source.country.toLowerCase() + "-")
      )
        ctx.addIssue({
          code: "custom",
          path: ["sources", index],
          message: "Duplicate source or mismatched country key",
        });
      keys.add(source.key);
      urls.add(url);
    });
  });
export type SourceCatalog = z.infer<typeof catalogSchema>;
export async function readSourceCatalog(): Promise<SourceCatalog> {
  return catalogSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../seeders/official-sources.json", import.meta.url),
        "utf8",
      ),
    ),
  );
}

// RFC 9562 UUIDv5, with the workspace as namespace: stable across catalog revisions.
export function catalogSourceId(workspaceId: string, key: string): string {
  const namespace = Buffer.from(
    uuid.parse(workspaceId).replaceAll("-", ""),
    "hex",
  );
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`tenderdesk:official-source:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const countries = { SA: "السعودية", JO: "الأردن", PS: "فلسطين" };
const sectors = {
  government: "حكومي",
  ministry: "وزارة",
  bank: "بنك",
  state_owned: "شركة حكومية",
  large_company: "شركة كبرى",
  development_fund: "صندوق تنمية",
  municipality: "بلدية",
  university: "جامعة",
};
const entryTypes = {
  central_platform: "منصة شراء مركزية",
  central_redirect: "إحالة إلى منصة مركزية",
  supplier_registration: "تسجيل مورد",
  public_tenders: "عطاءات منشورة",
};
const literal = (value: string) =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/** Produces administrative DML only. Never executes it, authenticates a user, or enables collection. */
export function buildSourceSeedSql(
  input: unknown,
  workspaceId: string,
  actorId: string,
): string {
  const catalog = catalogSchema.parse(input),
    workspace = uuid.parse(workspaceId),
    actor = uuid.parse(actorId);
  const entries = catalog.sources.map((source) => ({
    id: catalogSourceId(workspace, source.key),
    key: source.key,
    name: source.name,
    url: new URL(source.url).href,
    original_url: source.url,
    tags: [
      `country:${source.country}`,
      countries[source.country],
      sectors[source.sector],
      entryTypes[source.entry_type],
      source.name_en,
    ],
    policy: `${source.access_note}\n${source.entry_type === "supplier_registration" ? "الدخول والمشاركة وفق حساب المورد وإجراءات الجهة." : "المتابعة اليدوية متاحة من الرابط الرسمي؛ الجمع الآلي يحتاج موصلًا مناسبًا للصفحة ومراجعة شروط الوصول."}\nمرجع التحقق: ${source.evidence_url}\nتاريخ التحقق: ${source.checked_at}. حالة HTTP وقت الفحص: ${source.http_status ?? "غير متاحة"}.`,
    metadata: {
      key: source.key,
      version: catalog.catalog_version,
      country: source.country,
      sector: source.sector,
      entry_type: source.entry_type,
      evidence_url: source.evidence_url,
      checked_at: source.checked_at,
      http_status: source.http_status,
    },
  }));
  const body = `
declare
  w uuid := ${literal(workspace)}::uuid;
  actor uuid := ${literal(actor)}::uuid;
  entry jsonb;
  request uuid := gen_random_uuid();
  inserted integer := 0;
  skipped integer := 0;
begin
  perform 1 from public.workspaces where id=w for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;
  perform 1 from public.memberships m
    where m.workspace_id=w and m.user_id=actor and m.role='Owner' and m.active
      and exists(select 1 from public.identity_allowlist a where a.workspace_id=w and a.user_id=actor and a.status='active')
    for share;
  if not found then raise exception 'ACTIVE_OWNER_REQUIRED'; end if;
  for entry in select value from jsonb_array_elements(${literal(JSON.stringify(entries))}::jsonb) loop
    if exists(select 1 from public.sources s where s.workspace_id=w and (
      s.id=(entry->>'id')::uuid or s.adapter_config->'catalog'->>'key'=entry->>'key'
      or rtrim(split_part(s.url,'#',1),'/') in (rtrim(entry->>'url','/'),rtrim(entry->>'original_url','/'))
    )) then skipped := skipped+1; continue; end if;
    if (select count(*) from public.sources where workspace_id=w)>=500 then raise exception 'SOURCE_CAP_REACHED'; end if;
    insert into public.sources(id,workspace_id,name,kind,url,approved_hosts,approval,health,policy_note,adapter_config,adapter_required,tags,created_by)
      values((entry->>'id')::uuid,w,entry->>'name','manual',entry->>'url','{}','proposed','unknown',entry->>'policy',
        jsonb_build_object('catalog',entry->'metadata'),true,array(select jsonb_array_elements_text(entry->'tags')),actor);
    insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,request_id,details)
      values(w,actor,'source.catalog.seed','source',(entry->>'id')::uuid,'Owner-requested official source directory; manual access pending collection adapter',request,
        jsonb_build_object('catalog',entry->'metadata','execution','administrative_seeder'));
    inserted := inserted+1;
  end loop;
  raise notice 'Official sources inserted: %, preserved/skipped: %',inserted,skipped;
end;
`;
  // A content-dependent delimiter prevents catalog text from terminating the DO body.
  let delimiter = "$source_seed$";
  while (body.includes(delimiter)) delimiter = delimiter.slice(0, -1) + "_$";
  return `-- TenderDesk official catalog ${catalog.catalog_version}; administrative, atomic, insert-only.\nDO ${delimiter}${body}${delimiter};\n`;
}
