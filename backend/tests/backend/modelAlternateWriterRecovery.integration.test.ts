// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  recoverBlockedWriter,
  retainInvalidWriter,
} from "../../supabase/functions/_shared/modelWriterRecovery";
import {
  ModelDeferred,
  modelPrompt,
  sha256,
} from "../../supabase/functions/_shared/model";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { workflowFixture } from "./workflowFixture";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { modelLedger } from "../../supabase/functions/_shared/modelLedger";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";

describe("alternate paid writer recovery through the real graph and SQL store", () => {
  let db: Awaited<ReturnType<typeof workflowFixture>>;
  beforeAll(async () => {
    db = await workflowFixture();
  }, 30000);
  afterAll(async () => db?.db.close());

  it("preserves rejected candidate and paid usage while independently accepting a distinct existing response", async () => {
    await db.db.exec("begin");
    const rpc = async (name: string, args: Record<string, unknown> = {}) => {
      const entries = Object.entries(args);
      await db.db.exec("savepoint recovery_rpc;set local role service_role");
      try {
        return (
          await db.db.query<any>(
            `select public.${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(",")}) value`,
            entries.map(([, value]) =>
              value && typeof value === "object"
                ? JSON.stringify(value)
                : value,
            ),
          )
        ).rows[0]?.value;
      } catch (error) {
        await db.db.exec("rollback to savepoint recovery_rpc");
        throw databaseError(error as Error);
      } finally {
        await db.db.exec("reset role;release savepoint recovery_rpc");
      }
    };
    try {
      await db.command("model.routing", {
        enabled: true,
        expected_revision: 0,
      });
      const connection = await db.command("model.connection.save", {
        provider: "openai",
        label: "Synthetic recovery account",
        credential_alias: "APP_MODEL_OPENAI_KEY",
        project_ref: "fixture-project",
        enabled: true,
        expected_revision: 0,
      });
      const model = await db.command("model.configuration.save", {
        connection_id: connection.id,
        label: "Synthetic recovery model",
        model: "fixture-model",
        enabled: true,
        capabilities: defaultCapabilities("openai"),
        expected_revision: 0,
      });
      await db.command("model.task_route.save", {
        task: "default",
        model_ids: [model.id],
        inherit_default: false,
        strategy: "priority",
        profile: null,
        expected_revision: 0,
      });
      await db.command("model.execution.configure", {
        enabled: true,
        expected_revision: 0,
      });
      await db.command("model.probe", {});
      let job = await rpc("claim_backend_job_v2");
      const environments = modelEnvironments((name) =>
        name === "APP_MODEL_OPENAI_KEY" ? "synthetic-key" : undefined,
      );
      let checkSelection: ((args: any) => Promise<void>) | undefined;
      let guardCases = 0;
      let checkSuccessors: ((args: any) => Promise<void>) | undefined;
      const backend = {
        internal: async (name: string, args: any) => {
          if (
            name === "model_graph_store" &&
            args.action === "writer_alternative_select" &&
            checkSelection
          )
            await checkSelection(args);
          const result = await rpc(name, args);
          if (
            name === "model_graph_store" &&
            args.action === "writer_alternative_select" &&
            result === true
          ) {
            expect(await rpc(name, args)).toBe(true);
            expect(
              await rpc(name, {
                ...args,
                payload: { ...args.payload, candidate_hash: "0".repeat(64) },
              }),
            ).toBe(false);
            expect(
              await rpc(name, {
                ...args,
                payload: {
                  ...args.payload,
                  previous_candidate_hash: "0".repeat(64),
                },
              }),
            ).toBe(false);
            await checkSuccessors?.(args);
          }
          return result;
        },
        resolveModelEnvironment: (config: any) => ({
          ...environments.openai,
          model: config.model,
          projectRef: config.project_ref,
        }),
      } as unknown as Backend;
      const prefix = `step:${job.id}`;
      await modelLedger(backend, job, prefix, environments).preflight(
        [],
        "draft_section",
      );
      job = (
        await db.db.query<any>("select * from public.jobs where id=$1", [
          job.id,
        ])
      ).rows[0];
      const candidate = {
        key: "approach",
        title: "Approach",
        content_blocks: [
          {
            type: "paragraph",
            text: "Proposed work requires buyer confirmation.",
          },
        ],
        requirement_ids: [],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      };
      const previousCandidate = {
        ...candidate,
        content_blocks: [
          { type: "paragraph", text: "Delivery is unconditional." },
        ],
      };
      const originalHash = await sha256(
        modelPrompt("draft_section", {}, [], [], "en", false),
      );
      const graphInputHash = await sha256(
        JSON.stringify({
          version: 1,
          task: "draft_section",
          context: {},
          evidence: [],
          requiredIds: [],
          manifest: [],
          language: "en",
        }),
      );
      const threadId = await sha256(`${job.id}:${prefix}:${graphInputHash}`);
      let store = new ModelGraphStore(backend, job, threadId);
      await store.action("init", {
        input_hash: graphInputHash,
        task: "draft_section",
        graph_version: 1,
      });
      await db.db.query(
        "update app_private.model_graph_threads set candidate_count=3 where id=$1",
        [threadId],
      );
      await db.db.query(
        "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',3)",
        [threadId],
      );
      let gets = 0,
        verifierPosts = 0;
      const response = (id: string, result: unknown) =>
        Response.json({
          id,
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(result) }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        });
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (init?.method === "DELETE") return Response.json({ deleted: true });
        if (init?.method === "GET") {
          gets++;
          return response(
            String(url).split("/").pop()!,
            gets === 1 ? previousCandidate : candidate,
          );
        }
        const prompt = JSON.parse(
          JSON.parse(String(init?.body)).input.split("\nJSON schema: ")[0],
        );
        expect(prompt.task).toBe("verify_grounding");
        verifierPosts++;
        const context = prompt.untrusted_data;
        return response(`resp_verifier_${verifierPosts}`, {
          checked_candidate_hash: context.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: context.content_units.map(
            (unit: any) => unit.id,
          ),
          claims:
            context.verification_scope === "requirements_only"
              ? []
              : [
                  {
                    id: "claim",
                    claim: "Conditional proposal",
                    candidate_quote: context.content_units[0].text,
                    kind: "assumption",
                    status: "supported",
                    source_refs: [],
                    finding: "Proposed work.",
                  },
                ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        });
      });
      const options = {
        backend,
        job,
        prefix,
        task: "draft_section" as const,
        context: {},
        evidence: [],
        requiredIds: [],
        manifest: [],
        environments,
        language: "en" as const,
        repair: true,
        fetcher,
      };
      await store.action("result_put", {
        key: `semantic-instructions-${await sha256(`${prefix}:candidate-0`)}`,
        value: {
          version: 0,
          legacy_input_hash: await sha256(
            modelPrompt("draft_section", {}, [], [], "en", true),
          ),
        },
      });
      // Save the real initial-produce checkpoint. The exhausted allowance must
      // prevent any request while the already-paid original is not yet present.
      await expect(executeGuardedModel(options)).rejects.toMatchObject({
        code: "MODEL_CORRECTION_EXHAUSTED",
      });
      expect(fetcher).not.toHaveBeenCalled();
      const paidIds: string[] = [];
      for (let index = 0; index < 3; index++) {
        const id = crypto.randomUUID();
        const originalLease = crypto.randomUUID();
        paidIds.push(id);
        await db.db.query(
          `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,state,graph_candidate_recorded,connection_id,model_config_id,remote_project_ref,remote_request_id,remote_deadline,created_by)
           values($1,$2,$3,$4,$5,'openai','fixture-model',$6,current_date,1,100,50,100,50,0,'settled',true,$7,$8,'fixture-project',$9,now()+interval '1 hour',$10)`,
          [
            id,
            db.w,
            job.id,
            originalLease,
            `${prefix}:candidate-0:${originalHash.slice(0, 16)}:${index + 1}:${model.id}`,
            originalHash,
            connection.id,
            model.id,
            `resp_paid_${index}`,
            db.owner,
          ],
        );
        await db.db.query(
          `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,usage_id,sent,execution_metadata)
           values($1,$2,$3,'openai','fixture-model','draft_section',1,1,'failed','UNSUPPORTED_COMPANY_CLAIM',$4,true,$5)`,
          [
            db.w,
            job.id,
            originalLease,
            id,
            { input_hash: originalHash, graph_thread: threadId },
          ],
        );
      }
      const paidBefore = (
        await db.db.query<any>(
          "select * from public.provider_usage where id=any($1::uuid[]) order by id",
          [paidIds],
        )
      ).rows;
      // The real graph first recovers an already-paid initial candidate and
      // reaches its durable verify checkpoint. Seed the previously failed
      // verifier artifact as the fixture's starting condition, not an override
      // performed by production recovery.
      await expect(
        executeGuardedModel({ ...options, job }),
      ).rejects.toBeInstanceOf(ModelDeferred);
      job = await rpc("claim_backend_job_v2");
      store = new ModelGraphStore(backend, job, threadId);
      const previousSaved = await store.action("result_get", {
        key: "candidate-0",
      });
      expect(previousSaved.value.result).toEqual(previousCandidate);
      const previousHash = await sha256(
        JSON.stringify(previousSaved.value.result),
      );
      const initialMarker = await store.action("result_get", {
        key: `writer-recovery-${previousSaved.value.recovery_usage_id}`,
      });
      expect(initialMarker.value.candidate_hash).toBe(previousHash);
      const historicalHash = await sha256(JSON.stringify(previousCandidate));
      expect(historicalHash).not.toBe(previousHash);
      // Reproduce the historical pre-JSONB fingerprint without changing the
      // saved candidate. Recovery must preserve this old marker byte-for-byte.
      const historicalValue = {
        ...initialMarker.value,
        candidate_hash: historicalHash,
      };
      await db.db.query(
        "update app_private.model_graph_results set value=$2::jsonb,content_hash=encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex') where id=$1",
        [initialMarker.id, JSON.stringify(historicalValue)],
      );
      const historicalMarker = await store.action("result_get", {
        id: initialMarker.id,
      });
      const priorReport = {
        checked_candidate_hash: previousHash,
        reviewed_all_content: true,
        processed_content_ids: candidateContent(previousCandidate).map(
          (unit) => unit.id,
        ),
        claims: [
          {
            id: "claim",
            claim: "Unconditional delivery",
            candidate_quote: previousCandidate.content_blocks[0].text,
            kind: "assumption",
            status: "contradicted",
            source_refs: [],
            finding: "The stated unconditional commitment is unsupported.",
          },
        ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [
          {
            code: "CONDITION_REMOVED",
            severity: "blocking",
            detail: "Preserve the condition.",
            claim_ids: ["claim"],
            requirement_ids: [],
          },
        ],
      };
      const previousReport = await store.action("result_put", {
        key: `invalid-verification-repair-${previousHash}`,
        value: { result: priorReport, code: "MODEL_COVERAGE_INCOMPLETE" },
      });
      await db.db.query(
        "update app_private.model_graph_threads set status='needs_review' where id=$1",
        [threadId],
      );
      checkSelection = async (args: any) => {
        const variants: [
          string,
          (input: any) => Promise<void> | void,
          boolean?,
        ][] = [
          [
            "missing usage",
            (input) => {
              delete input.payload.usage_id;
            },
          ],
          [
            "wrong request hash",
            (input) => {
              input.payload.input_hash = "0".repeat(64);
            },
          ],
          [
            "wrong original phase",
            (input) => {
              input.payload.request_prefix = "another:candidate-0";
            },
          ],
          [
            "malformed evidence hash",
            (input) => {
              input.payload.evidence_hash = "not-a-hash";
            },
          ],
          [
            "wrong prior report",
            (input) => {
              input.payload.previous_report_id = previousSaved.id;
            },
          ],
          [
            "reused initial usage",
            (input) => {
              input.payload.usage_id = previousSaved.value.recovery_usage_id;
            },
          ],
          [
            "missing source receipt",
            async (input) => {
              await db.db.query(
                "update app_private.model_graph_results set value=value-'code' where thread_id=$1 and result_key=$2",
                [threadId, "invalid-writer-" + input.payload.usage_id],
              );
            },
          ],
          [
            "same content",
            async (input) => {
              await db.db.query(
                "update app_private.model_graph_results set value=jsonb_set(value,'{result}',$2::jsonb) where id=$1",
                [
                  input.payload.candidate_id,
                  JSON.stringify(previousSaved.value.result),
                ],
              );
            },
          ],
          [
            "unreviewed predecessor",
            async () => {
              await db.db.query(
                "update app_private.model_graph_results set value=jsonb_set(value,'{result,reviewed_all_content}','false') where id=$1",
                [previousReport.id],
              );
            },
          ],
          [
            "mismatched report hash",
            async () => {
              await db.db.query(
                "update app_private.model_graph_results set value=jsonb_set(value,'{result,checked_candidate_hash}',to_jsonb($2::text)) where id=$1",
                [previousReport.id, "0".repeat(64)],
              );
            },
          ],
          [
            "no actual defect",
            async () => {
              await db.db.query(
                "update app_private.model_graph_results set value=jsonb_set(jsonb_set(value,'{result,claims}','[]'),'{result,findings}','[]') where id=$1",
                [previousReport.id],
              );
            },
          ],
          [
            "unresolved usage",
            async (input) => {
              await db.db.query(
                "update public.provider_usage set state='unknown' where id=$1",
                [input.payload.usage_id],
              );
            },
          ],
          [
            "stale lease",
            (input) => {
              input.lease = crypto.randomUUID();
            },
            true,
          ],
          [
            "foreign thread",
            (input) => {
              input.thread_id = "0".repeat(64);
            },
            true,
          ],
        ];
        for (const [label, alter, throws] of variants) {
          await db.db.exec("savepoint alternate_guard_case");
          try {
            const input = structuredClone(args);
            await alter(input);
            if (throws)
              await expect(
                rpc("model_graph_store", input),
                label,
              ).rejects.toThrow();
            else
              expect(await rpc("model_graph_store", input), label).toBe(false);
            guardCases++;
          } finally {
            await db.db.exec(
              "rollback to savepoint alternate_guard_case;release savepoint alternate_guard_case",
            );
          }
        }
        expect(
          (
            await db.db.query<any>(
              "select has_table_privilege('authenticated','app_private.model_writer_recovery_choices','select') as table_access,has_function_privilege('authenticated','app_private.alternate_paid_writer(uuid,uuid,text,text,jsonb)','execute') as function_access",
            )
          ).rows[0],
        ).toEqual({ table_access: false, function_access: false });
      };
      checkSuccessors = async (args: any) => {
        await db.db.exec("savepoint successor_limit");
        const direct = (action: string, payload: any) =>
          rpc("model_graph_store", { ...args, action, payload });
        try {
          const first = await direct("result_get", {
            id: args.payload.candidate_id,
          });
          const remaining = paidIds.find(
            (id) =>
              id !== previousSaved.value.recovery_usage_id &&
              id !== args.payload.usage_id,
          )!;
          const thirdResult = {
            ...candidate,
            content_blocks: [
              {
                type: "paragraph",
                text: "Delivery depends on the agreed confirmation.",
              },
            ],
          };
          await direct("result_put", {
            key: "invalid-writer-" + remaining,
            value: {
              usage_id: remaining,
              request_prefix: args.payload.request_prefix,
              request_input_hash: originalHash,
              task: "draft_section",
              code: "UNSUPPORTED_COMPANY_CLAIM",
              producer: first.value.producer,
              result: thirdResult,
            },
          });
          const next = await direct("result_put", {
            key: "paid-writer-alternative-" + remaining,
            value: {
              result: thirdResult,
              producer: first.value.producer,
              recovery_usage_id: remaining,
            },
          });
          const firstHash = await sha256(JSON.stringify(first.value.result));
          const nextHash = await sha256(JSON.stringify(next.value.result));
          const firstReport = {
            ...priorReport,
            checked_candidate_hash: firstHash,
            processed_content_ids: candidateContent(first.value.result).map(
              (unit) => unit.id,
            ),
            claims: [
              {
                ...priorReport.claims[0],
                candidate_quote: first.value.result.content_blocks[0].text,
              },
            ],
          };
          const firstReportRow = await direct("result_put", {
            key: "invalid-verification-repair-" + firstHash,
            value: { result: firstReport, code: "MODEL_COVERAGE_INCOMPLETE" },
          });
          const second = {
            ...args.payload,
            usage_id: remaining,
            candidate_id: next.id,
            candidate_hash: nextHash,
            previous_candidate_id: first.id,
            previous_candidate_hash: firstHash,
            previous_report_id: firstReportRow.id,
            previous_report_hash: await sha256(
              JSON.stringify(firstReportRow.value.result),
            ),
          };
          expect(await direct("writer_alternative_select", second)).toBe(true);
          expect(
            await direct("writer_alternative_selections", {}),
          ).toHaveLength(2);
          expect(
            await direct("writer_alternative_select", {
              ...second,
              usage_id: args.payload.usage_id,
              candidate_id: first.id,
              candidate_hash: firstHash,
              previous_candidate_id: next.id,
              previous_candidate_hash: nextHash,
            }),
          ).toBe(false);
          expect(
            await direct("writer_alternative_select", {
              ...second,
              usage_id: previousSaved.value.recovery_usage_id,
              candidate_id: previousSaved.id,
              previous_candidate_id: next.id,
              previous_candidate_hash: nextHash,
            }),
          ).toBe(false);
          expect(
            (
              await db.db.query<any>(
                "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
                [threadId],
              )
            ).rows[0].candidates,
          ).toBe(3);
        } finally {
          await db.db.exec(
            "rollback to savepoint successor_limit;release savepoint successor_limit",
          );
        }
      };
      let accepted: any;
      for (let attempt = 0; attempt < 6 && !accepted; attempt++) {
        try {
          accepted = await executeGuardedModel({ ...options, job });
        } catch (error) {
          expect(error).toBeInstanceOf(ModelDeferred);
          job = await rpc("claim_backend_job_v2");
          expect(job.id).toBe(options.job.id);
          store = new ModelGraphStore(backend, job, threadId);
        }
      }
      expect(accepted?.result).toEqual(candidate);
      expect(gets).toBe(2);
      expect(guardCases).toBe(14);
      expect(verifierPosts).toBe(1);
      expect(options.repair).toBe(true);
      expect(
        (
          await db.db.query<any>(
            "select status,candidate_count from app_private.model_graph_threads where id=$1",
            [threadId],
          )
        ).rows[0],
      ).toEqual({ status: "accepted", candidate_count: 3 });
      expect(
        (
          await db.db.query<any>(
            "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
            [threadId],
          )
        ).rows[0].candidates,
      ).toBe(3);
      expect(
        (
          await db.db.query<any>(
            "select * from public.provider_usage where id=any($1::uuid[]) order by id",
            [paidIds],
          )
        ).rows,
      ).toEqual(paidBefore);
      expect(
        (await store.action("result_get", { key: "candidate-0" })).value.result,
      ).toEqual(previousCandidate);
      expect(
        (await store.action("result_get", { id: previousReport.id })).value
          .result,
      ).toEqual(priorReport);
      const selections = await store.action("writer_alternative_selections");
      expect(selections).toHaveLength(1);
      expect(selections[0]).toMatchObject({
        previous_candidate_id: previousSaved.id,
        previous_report_id: previousReport.id,
      });
      expect(selections[0].resumed_at).toBeTruthy();
      expect(selections[0]).toMatchObject({
        previous_candidate_hash: previousHash,
        previous_hash_derivation: "persisted_candidate_json",
        legacy_marker_hash: historicalHash,
      });
      expect(
        await store.action("result_get", { id: historicalMarker.id }),
      ).toEqual(historicalMarker);
      expect(
        (await store.action("result_get", { id: selections[0].candidate_id }))
          .value.result,
      ).toEqual(candidate);
    } finally {
      await db.db.exec("rollback");
    }
  }, 30000);
});
