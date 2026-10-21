import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// This is a bounded release command, not a general SQL endpoint or migration
// directory scanner. Sources come only from the checked-out, reviewed revision.
const release = [
  ["20261020141244", "model_catalog_and_task_routes"],
  ["20261020141542", "model_target_identity_and_execution"],
  ["20261020143042", "durable_model_graph"],
  ["20261020150037", "model_graph_recovery_and_retention"],
  ["20261020195225", "automatic_model_transport"],
  ["20261021002125", "scope_model_resume_to_phase"],
  ["20261021003448", "reconcile_orphaned_model_reservations"],
  ["20261021005033", "scope_unknown_task_reservations_to_phase"],
  ["20261021010317", "healthy_model_poll_eligibility"],
  ["20261021071021", "model_continuation_queue_fairness"],
  ["20261021071753", "complete_draft_export_context"],
  ["20261021073417", "immutable_model_phase_prompt_pin"],
  ["20261021085510", "bounded_queue_wakeup"],
  ["20261021091037", "retained_verification_recovery_guard"],
  ["20261021092435", "generation_plan_blocked_status"],
  ["20261021094701", "terminal_queue_wakeup"],
  ["20261021095309", "deferred_queue_wakeup"],
  ["20261021095545", "automatic_gemini_reasoning"],
  ["20261021102512", "recover_paid_writer_candidate"],
  ["20261021120717", "retry_one_generation_job"],
  ["20261021120832", "accepted_model_poll_wakeup"],
  ["20261021123321", "preserve_unchanged_notice_details"],
  ["20261021130940", "wake_unchanged_notice_continuations"],
  ["20261021131353", "proposal_section_outline"],
  ["20261021131657", "recover_alternate_paid_writer"],
];
const project = "nqfwbqeozmuiuwbiowil";
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

export async function applyModelRelease({
  token,
  fetcher = fetch,
  readMigration = (file) =>
    readFile(
      new URL("../../supabase/migrations/" + file, import.meta.url),
      "utf8",
    ),
  log = console.log,
}) {
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
  const query = async (sql, readOnly = false) => {
    const response = await fetcher(
      `https://api.supabase.com/v1/projects/${project}/database/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql, read_only: readOnly }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      // Do not log request headers, SQL, returned row values or secret values.
      throw new Error(
        `Supabase migration request failed: HTTP ${response.status}`,
      );
    }
    const result = await response.json();
    if (!Array.isArray(result))
      throw new Error("Unexpected migration response");
    return result;
  };
  const rows = await query(
    "select version,name from supabase_migrations.schema_migrations order by version",
    true,
  );
  const applied = new Set(rows.map((r) => r.name));
  for (const [version, name] of release) {
    if (name === "durable_model_graph") {
      const storage = applied.has("durable_model_graph_storage");
      const rpc = applied.has("durable_model_graph_store_rpc");
      const commits = applied.has("durable_model_graph_domain_commits");
      if ((rpc && !storage) || (commits && (!storage || !rpc))) {
        throw new Error("Incomplete graph migration history");
      }
      if (storage && rpc && commits) {
        log("Already applied: durable_model_graph (three recorded parts)");
        continue;
      }
    }
    if (applied.has(name)) {
      log(`Already applied: ${name}`);
      continue;
    }
    if (rows.some((r) => r.version === version)) {
      throw new Error(`Migration version collision: ${version}`);
    }
    const original = await readMigration(`${version}_${name}.sql`);
    let sql = original;
    if (name === "durable_model_graph") {
      // The connector completed storage before its request-state failure.
      // Keep exact statement boundaries and do not recreate existing tables.
      const store = original.indexOf(
        "create function public.model_graph_store(",
      );
      const complete = original.indexOf(
        "create function public.complete_generation_graph(",
      );
      if (store < 0 || complete <= store)
        throw new Error("Graph migration boundaries changed");
      if (applied.has("durable_model_graph_store_rpc")) {
        if (!applied.has("durable_model_graph_storage")) {
          throw new Error("Incomplete graph migration history");
        }
        sql = original.slice(complete);
      } else if (applied.has("durable_model_graph_storage")) {
        sql = original.slice(store);
      }
    }
    // DDL and its history record commit together. A failed or interrupted call
    // is checked against migration history on the next run; never auto-replay
    // a response with an unknown outcome in this process.
    await query(
      "begin;\nset local lock_timeout='10s';\n" +
        sql +
        "\ninsert into supabase_migrations.schema_migrations(version,name,statements)" +
        ` values(${literal(version)},${literal(name)},array[${literal(original)}]);\ncommit;`,
    );
    applied.add(name);
    log(`Applied: ${name}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  applyModelRelease({ token: process.env.SUPABASE_ACCESS_TOKEN }).catch(
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
