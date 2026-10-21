# Implementation status and continuation plan

## October 21 — real acceptance blockers (in progress)

Current status at 12:15 UTC: analysis remains 3/3 and planning 9/9 accepted;
**11/67 draft jobs are accepted**, with 53 queued, one running and two blocked.
No complete Word has been downloaded or inspected. Company paraphrase/translation
validation and paid-result recovery were deployed as API v74 / worker v93;
normal worker v95 has the same canonical 40 files. Source
`c1c378afa6348bb58f3c1af03706f015d97abf85` passed
[CI and Pages 39596580459](https://github.com/salahassi/tenders/actions/runs/39596580459).
The authenticated UI retry exposed a separate `USAGE_REVIEW_REQUIRED` bug: the
old per-job action invoked whole-plan retry and refused another job's accepted
pending request. The new targeted retry migration requeues only the selected
blocked/failed current-stage job, preserving sibling work, attempts, candidate
budgets and pending usage. Its focused database tests pass 29/29, including
permissions, idempotency, evidence/revision guards and reserved/unknown usage.

A bounded GET-only diagnostic of the second blocked response returned a
`confidential-` policy match in ordinary paragraph text, with no email or
credential match. It did not establish the character following the hyphen.
Local validation now distinguishes joined word compounds such as
`confidential-information` from explicit classification labels; whitespace or
label punctuation, standalone classifications, secrets and email checks remain.
Model regression tests pass 64/64. A further temporary diagnostic deployment
was rejected by automatic review and was not deployed or retried; verification
will use the ordinary processing path. The live policy cause remains conditional
until normal retry succeeds.

The next queue migration wakes normal work after a canceled job and supports one
bounded wake at the already-saved due time of an exact healthy accepted remote
request. It preserves the 30-second polling interval, current permissions,
revision/lease guards, request identity, normal dispatcher fairness and model
reservation serialization. Another reservation, a potentially active matching
unknown request, or a cron race prevents that optimization. Historical unrelated
unknown telemetry does not block a known accepted request. Focused queue/release
tests pass 110/110 after the scope correction. Full backend regression passed
842/842 in 52 files (262.87 seconds); backend typecheck/build, both Deno entrypoints
and frontend typecheck, 192 tests and build passed. The targeted-retry migration
and API v75 / worker v96 deployed at 12:25 UTC with exact hosted readback of all
28/40 files. The independently reviewed accepted-poll migration deployed at
12:29 UTC; its revision RPC is service-role-only and the anonymous worker returns
401. The same three security-advisor categories remain. Actual browser retries
returned HTTP 200 and queued only their selected jobs. The original company-claim
job subsequently returned `MODEL_CORRECTION_EXHAUSTED` with no recovery artifact
or new writer attempt; the recovery preconditions are under investigation.
The policy-blocked job remains queued. Real accepted recovery and full Word
completion are not yet established.

Current status at 11:57 UTC: **analysis 3/3 and planning 9/9 are accepted;
eight of 67 draft jobs have completed. No complete Word has been downloaded or
inspected.** The bounded diagnostic hold expired at 10:43 and ordinary processing
resumed. At 11:52, 56 drafts were queued, one retained an in-progress model
request, and two were blocked (the original company-claim guard and a separate
output-policy failure under investigation). Since 10:34, the plan recorded 31
settled usage records with 308,055 input / 81,177 output tokens and one reserved
request. These are reported tokens, not a price estimate or a completed journey.

Company-claim correction and paid-result recovery were implemented at this
checkpoint and deployed at 12:01 UTC. In the graph executor, deterministic validation checks a verified
company source and a contiguous normalized quotation; claim paraphrases and
translations must pass mandatory independent semantic verification. Legacy
execution keeps its existing guards. The generation callback and final
validation carry the same server-controlled verification mode. Invalid writer
results are retained privately. Recovery binds an already-counted, settled
candidate to its exact job, prompt hash, graph thread and producer, rechecks
current data permissions, and resumes normal verification without another writer
POST, usage settlement or budget reset. Missing retained responses do not cause
new generation. The canonical graph replay integration passed with three original
paid candidates and unchanged writer budget 3, then required an independent
verifier before acceptance. Focused guard tests passed 16/16; the expanded
company-claims integration now passes 4/4, and recovery/graph tests passed 31/31.
Backend typecheck/build and both Deno entrypoints pass. Final full regression
`final-backend-serial-16.log` passed **800/800 tests in 52 files** (274.85 seconds).
The recovery migration is applied and API **v74** / worker **v93** deployed at
12:01 UTC, with all 28/40 source files matching hosted readback. The graph RPC
remains service-role-only, anonymous worker POST returns 401, and the same three
security-advisor categories remain unchanged. Actual browser retry and recovery
of the original experience-section job are pending; no real recovery or full
Word completion is claimed by the automated tests.

Historical status at 10:25 UTC: **all three analysis jobs and all nine planning
steps are accepted, and 67 drafting jobs have been created. No complete Word
proposal has been downloaded or inspected.** The first independent drafting
job completed at 10:22: one of 67 is accepted. Its Gemini verification used the
preserved medium profile (requested/effective medium), 9,156 input / 5,115 output
tokens, including 2,559 thinking tokens. This proves the control was sent for
that real request; it does not establish LOW performance or causality.
The first experience-section job received HTTP 200 from all three
writer models, but each response failed local `UNSUPPORTED_COMPANY_CLAIM`
validation; the job is blocked at its correction limit. Authenticated GET-only
retrieval of the two already-paid OpenAI responses confirmed the exact failing
condition: each used a contiguous quotation from an available verified company
source, but the claim wording was not a literal substring of that quotation.
The semantic truth of the claims still requires independent verification.
The temporary diagnostic returned only booleans/counts/codes, made no generation
request, and was removed immediately. Normal worker **v92** exactly matches the
canonical v90 bundle (39 files). Guard correction and paid-result recovery are
being implemented; no candidate budget or usage record has been reset.

Sixty-five queued, unstarted drafting jobs were on an audited bounded hold until
10:43 UTC while that failure is investigated. The hold changes no input, budget
or usage records and does not hold pending provider work. Completed analysis,
planning outputs and received model results remain saved. Draft acceptance,
commercial missing-input handling, review and real Word download/inspection
remain open.

The automatic Gemini reasoning migration was applied at 10:13 UTC. API **v73**
and normal worker **v90** were deployed at 10:14 UTC; exact readbacks matched all
28 API and 39 worker files. Worker v90 includes the previously deployed v89
terminal/deferred queue-wake changes. Anonymous worker POST returns HTTP 401,
and the new reasoning RPC denies anon/authenticated execution while permitting
service_role. The final complete backend regression
(`final-backend-serial-15.log`) passed **757/757 tests in 49 files** (230.53
seconds), with backend typecheck/build and both Deno entrypoint checks. Unchanged
frontend code previously passed all **192 tests**, typecheck and build. Source
`557420f7e26e9ff32642cc0a6aa1eaf01eceeb63` passed all CI checks and
[Pages 39583577517](https://github.com/salahassi/tenders/actions/runs/39583577517).

New verification operations now default to low reasoning. Existing explicit
profiles and already-started operation identities remain preserved; accepted
requests resume through GET using their original recorded metadata. Optional
Gemini reasoning controls are negotiated once only after an explicit HTTP
400/422 rejection of the exact control or level sent. Generic 400 errors, schema
errors and ambiguous requests cannot trigger that negotiation. Its recorded
compatibility decision is scoped to connection, model/settings revision,
transport and requested level. **No live successful LOW request or resulting
token/time improvement has yet been established.**

Historical checkpoint at 10:00 UTC: **analysis and all nine planning steps were
accepted; no complete Word had been downloaded or inspected.**
The authenticated Jobs page's Check retry action resumed the exact blocked step
at 09:25 (HTTP 200, same plan). Its graph is now committed with one recovery
provenance record. The original input hash, received-candidate count of one,
writer/verifier/correction budgets, and five usage records are unchanged:
65,896 input / 37,730 output tokens before and after. Recovery made **zero new
provider requests**. Subsequent independent Gemini verifications also succeeded.
Source `9daf07f559bbf981e91ca25663c3e9690552308f` passed
[Pages 39576379872](https://github.com/salahassi/tenders/actions/runs/39576379872).

The live retry exposed a separate display-state defect: successful independent
steps could overwrite the parent plan's blocked status and hide Resume. An
additive private trigger now preserves a current blocked child's status when
sibling work updates the parent, while allowing independent steps, ordinary
retry and cancellation to continue. Its audited one-time repair changes only
the aggregate status/revision, not child jobs, checkpoints, budgets or usage.
The focused canonical PostgreSQL/status/release tests passed **52/52**, backend
typecheck and independent review passed. The hosted migration is applied; the
trigger is enabled and no API role can execute its private function directly.
No existing plan needed aggregate repair at deployment. The stable full backend
regression (`final-backend-serial-14.log`) passed **693/693 tests in 47 files**
(246.96 seconds); backend typecheck/build passed. Its preceding run passed 691
cases but found a test-fixture defect:
the healthy MODEL_IN_PROGRESS case used the failure RPC, creating a second
blocked job whose ordinal could precede the expected blocker. The corrected
case uses the actual graph yield RPC and asserts retry_wait; a separate case
checks deterministic selection between two real blockers. The SQL is unchanged.
At that checkpoint, API v72 and worker v88 remained active. Frontend rerun passed all
**192 tests**, typecheck and production build; no frontend code changed.

At 09:40 UTC, eight of nine planning steps are accepted with the final step
running and no blocked child. The prior seven accepted outputs map 111 distinct
requirements into 383 section assignments, expanding to 57 prose-writing steps
under the existing eight-requirement bound. This is a measured remaining
workload, not duplicate provider dispatch. Larger prose batches remain an
unapplied experiment until actual writer/verifier output proves safe sizing;
stored mappings and task settings are unchanged. Full Word acceptance remains
pending. Failure mail has not been sent since October 20 at 17:36 UTC; the one
existing queued summary retains its configured next delivery window.

Source `8efdb3c421015a1c59ff56bccc7d86cf60805ee7` passed
[Pages 39579246925](https://github.com/salahassi/tenders/actions/runs/39579246925).
The final planning step's Gemini content-verification batch later returned
HTTP 200 / MAX_TOKENS: 8,590 input, 16,369 total output, including 15,414
thinking tokens and only about 955 visible output tokens. This was a bounded
32-unit/4,187-character content batch, not the whole report. The frozen operation
requested medium reasoning, but conservative empty capabilities resolved it to
none and omitted the control; none means provider default, not disabled
thinking. Google's documented default is also medium, so merely sending medium
does not establish a fix. A lower default for new verification work and bounded,
transport-specific optional-control negotiation were then being implemented;
the deployed follow-up is recorded above. Existing explicit profiles and accepted
requests retain their identity. Sol later accepted this same content batch;
overall planning was still unfinished at that checkpoint.

Queue timing investigation confirms successful wakes are delivered: normal
fairness assigns the next turn to an old source/assessment job, which can block
on a redirected source URL. Terminal failure did not wake the following ready
graph, adding 60–75-second idle gaps. One clean planning job spent 202 of 488
seconds in such inter-phase gaps. An additive terminal-completion wake and a
single delayed retry after the existing ten-second throttle were then prepared;
neither changes job ordering, retry schedules or concurrency. Their deployment
is recorded below; no measured live performance improvement is asserted.

Queue follow-up deployment at 10:00 UTC: both terminal/deferred wake migrations
are applied. Worker **v89** contains only the v88 bundle plus the new bounded
queue-wake helper and handler call; all **38 files** match hosted readback.
The detailed RPC is service-role-only and anonymous worker POST still returns
401. Focused queue/delay/release tests passed **76/76** and broader
worker/source/notification tests passed **110/110**, with typecheck and
independent review. The pending reasoning changes are not in this deployment.
The final planning coverage report succeeded on Gemini at 09:57:58; the local
advance-plan job is queued, competing with 44 older due assessments. Live
continuation latency and the first real draft output remain to observe.

Historical status at 09:00 UTC: **analysis is complete, but the real proposal is
blocked during planning; no complete Word has been downloaded or inspected.**
Three of nine planning jobs succeeded, one reached
`MODEL_CORRECTION_EXHAUSTED`, and five remain queued. Gemini's first rejected
verification copied source text into a candidate quotation. Luna then failed
coverage validation and Sol failed numeric-evidence validation. All returned
HTTP 200; these were local response-validation failures, not a new Gemini HTTP
400. The final corrective Sol response used 17,491 input / 8,212 output tokens.

Private replay identified an application false positive in that last saved
report: its candidate quotation contains a known evidence UUID, and the numeric
guard treats the UUID fragments as factual numbers. The 21-claim report and all
18 requirement checks otherwise validate. The narrow guard now excludes only
exact standalone supplied evidence/requirement UUIDs from numeric comparison;
unknown or embedded identifiers and actual adjacent quantities remain checked.
Known identifier digits cannot justify factual numbers on the source side.
All 57 grounding tests and backend typecheck pass. The unchanged saved report
passes full validation with zero actionable defects. Worker v87 deployed the
guard-only change at 09:12 UTC; all 36 source files matched on readback. Source
`e55a9a8c6511cc17ae72485e1bd2d445e1f10a3a` is pushed to main; its Pages workflow
39575113127 passed all checks and publication. Validated recovery of the saved report is
prepared but not deployed; no budgets or paid results have been reset, and the
blocked job has not been resumed yet. Other independent
planning work continued and reached four accepted jobs at 09:10 UTC.

Two related improvements are prepared, not deployed: private retention of each
distinct invalid verifier result (the corrective input still uses the first),
and a service-only, revision-deduplicated queue wake after successful lease
release. The latter retains normal claim ordering, a ten-second workspace
throttle, active lease/reservation checks, provider retry timing and cron
fallback. Actual first-three-plan observations showed about ten minutes of
idle inter-phase gaps without another inference occupying them. Focused checks
passed seven graph/history tests, 73 worker/source/notification tests and 39
canonical graph-release/release-command tests. Complete regression and hosted
recovery evidence remain pending.

The proposed blocked-graph recovery revalidates the unchanged current candidate
and complete retained corrective report, requires zero actionable defects and
no reserved/unknown request or saved provider round, then resumes the normal
decision/acceptance nodes. It records private provenance and preserves received
candidate counts, repair counts, budgets and usage. An interrupted acceptance
replays only the identical cached candidate with matching provenance. Twenty
helper cases and two database/LangGraph integrations pass, including the
accepted-result-write crash boundary; independent review passed. The actual
browser retry and recovered job acceptance remain pending.

Combined release validation (`final-backend-serial-12.log`) passed **679/679
tests in 46 files** in 206.60 seconds, plus backend typecheck/build and both Deno
entrypoint checks. The two additive queue-wakeup/recovery-guard migrations are
applied; anon/authenticated cannot execute their service boundary. Worker v88
deployed the combined code at 09:22 UTC; all 37 source files matched on readback
and an unauthenticated POST still returned 401. Source
`9daf07f` is pushed to main. Live acceptance remains pending. An earlier overlapping run
(`serial-11`) was inconclusive: new grounding tests were loaded against a
pre-edit module and one fixture exceeded its setup timeout; the isolated export
suite passed and the stable full run above passed every test.

Historical checkpoint at 08:24 UTC: **all three original analysis jobs succeeded**.
The final graph committed at 08:17:30 with the received-candidate count unchanged
at two. The real analysis produced 145 requirements and advanced into nine
planning jobs. The first planning writer, OpenAI gpt-6.1-sol, completed between
08:18 and 08:20 with 9,530 input / 4,145 output tokens. Its Gemini verification
then succeeded (12,417 input / 11,188 output tokens), and the first planning job
is accepted; eight planning jobs remain queued. **The end-to-end journey remains
incomplete: no complete Word proposal has been downloaded or inspected.**

API **v72** remains unchanged. Normal worker **v86**, deployed at 08:21 UTC,
matched all 36 submitted source files on readback. Its narrow continuation
optimization merges and accepts a completed final requirements-verification
batch within the same lease when at least ten seconds remain. With less time it
keeps the cached result and yields; content batches retain one model request per
worker continuation. It makes no extra model calls and preserves all validation,
leases and request identity. The change passed 106 focused tests, backend
typecheck/build and both Deno entrypoint checks. The complete backend regression
(`final-backend-serial-10.log`) passed 617/617 tests in 44 files (219.49 seconds).
The preceding complete suite passed 616/616 tests in 44 files (217.62 seconds). Source `fd629ec8c402fb27ac00803329f9dacbb33b0c7e` passed [Pages 39569125961](https://github.com/salahassi/tenders/actions/runs/39569125961), including the full package checks and publication. API remains v72 and worker v86; real Word acceptance remains pending.

At 07:53:29 UTC, a revision-guarded audited resume removed the trial's bounded
hold at job revision 176 without changing budgets, usage or saved results.
Normal worker dispatch 5580 was requested. Live readback now confirms one
recovery marker, an unchanged received-candidate count of two, and no request
for a second writer repair. Completed results were reused without generating
that unnecessary replacement candidate.

At 07:59:49 UTC, the first new verification batch using the pinned v2 instructions
(`content-2`) completed successfully on Gemini and was cached. It used 6,210
input / 5,842 output tokens in approximately 38 seconds, with no HTTP 400 or
provider failover for that call. All four content batches after the prompt change
subsequently succeeded on Gemini without failover, using a combined 24,509 input
/ 22,807 output tokens. The requirements-coverage report was cached at 08:12,
and complete analysis acceptance followed at 08:17:30. This closes the original
analysis blocker; planning, drafting, commercial missing-input handling, review
and browser Word download/inspection still have to complete.

Scheduler follow-up at 08:02 UTC: the trial's third analysis job progressed at
07:59 and again at 08:02, with two successful Gemini verification calls after
the prompt correction. Its preceding `MODEL_RATE_WAIT` was a local reservation
wait, not a provider request or HTTP 429. The current scheduler does not guarantee
a bounded wait: a local capacity wait counts as an interactive turn, its
one-minute retry can miss a newly freed model slot, and source jobs waiting over
two minutes outrank the proposal/assessment alternation. Accepted-request polls
still take priority and the single lease/reservation protections remain intact.
Record admission fairness as follow-up work; no further scheduling logic is
changed during this progressing live test. The real proposal journey and Word
download/inspection remain in progress under the main acceptance run.

Earlier completion work (API v71 / worker v84 deployed at 07:44 UTC;
exact source readbacks matched 26/33 files):
draft export now retains generated commercial/delivery inputs, model review
coverage and unresolved questions, explicitly unconfirmed. Confirmed calculations
and manual compliance take precedence; final approval requirements and separate
technical/financial volumes are preserved. Its additive export-context migration
is applied. Five draft-export tests, 25 generation tests, five commercial tests
and 13 release tests passed.

New planning and review steps use bounded requirement packing (24/12 records
respectively, at most 12,000 serialized requirement-context characters). Stored
steps are never repacked; every ordered ID remains present, and drafting,
commercial, routing and response limits are unchanged. At the earlier partial
analysis checkpoint, 96 accepted requirements packed into six planning and eight
review jobs versus eight and twenty previously. The final 145-requirement analysis
now creates nine planning jobs, as recorded above. These counts measure scheduled
primary jobs, not guaranteed model calls or completion time. Review now receives
relevant generated commercial inputs as unconfirmed content; it cannot treat them
as evidence or approved commitments.
All 41 focused generation/evidence/batching tests passed, as did typecheck,
build and Deno checks. The combined full backend run passed 591/591 tests in
42 files (223.75 seconds). A subsequent draft-only localized table-label change
passed its five export tests and typecheck. Synthetic English/Arabic DOCX visual
QA produced five/six pages with no clipped tables or page overflow; this is
renderer validation, not the original RFP acceptance artifact.

At the user's prompt-correction steering, new requests for the trial were
temporarily deferred at a safe boundary with no reserved request. Its audit
records the previous retry time and unchanged budgets/usage. The bounded hold
was extended with an audit to 08:01:58 UTC, then released at 07:53:29 after the
fix was deployed and verified. Existing accepted results remain saved. The
latest invalid Gemini quote spliced two source passages; the complete source
was supplied. The new verifier instructions make contiguous quotations and
separated references explicit at the initial request, preserving the original
input identity for already-started phases.

Private inspection of the next saved Sol report confirmed another application
defect: its three `assumption` / `insufficient` entries correctly describe
missing company inputs already retained in the candidate's questions and
owner-question fields. Treating every insufficient verdict as a rewrite caused
an unnecessary second repair to be scheduled. The narrow correction keeps
these assumptions unresolved without declaring them supported; contradictions,
unsupported factual claims, blocking findings and required coverage still block
acceptance. The exact saved report validates all 40 claims with zero remaining
repair defects; 54 focused grounding/verification tests passed. Recovery must
revalidate the saved candidate and all remaining batches without changing
received-candidate budgets or duplicating accepted requests.

Worker v84 first deployed the narrow grounding correction together with bounded
new planning/review batches; API v71 deployed the completed-draft export context
and renderer. They are superseded by API v72 / worker v85, which also contain
the separately verified prompt pin and safe false-repair recovery.

The additive `immutable_model_phase_prompt_pin` migration is applied. Its
service-only `model_phase_started` RPC denies anon/authenticated execution and
allows service_role. Immutable per-phase prompt pins preserve old user/system
bytes for previously started calls or saved rounds, including unknown or settled
usage whose result has not yet been saved. New verification phases receive
trusted system instructions requiring exact contiguous quotations, separate
references for separated passages, and explicit uncertainty for missing company
evidence. The policy version and constant instructions are included in the
input identity; existing accepted requests cannot silently acquire new wording.

Safe recovery now revalidates a retained repair-only report against its exact
saved candidate, content scope and evidence before undoing an unnecessary
scheduled repair. It proceeds only when no actionable defects remain, no next
candidate or saved provider round exists, and the service RPC and preflight
confirm the scheduled writer phase has not started. It records an idempotent
provenance marker and reverses only that unstarted scheduling increment.
Received-candidate budgets, cached reports, usage and completed results remain
unchanged. Remaining content batches and whole-candidate coverage must still
pass; this recovery cannot accept a partial report or cancel an accepted request.

The combined prompt/recovery/grounding follow-up passed 72 focused tests across
six files, backend typecheck/build and both API/worker Deno checks. An independent
private replay of the actual saved 44-claim repair-only report passed the recovery
helper's candidate, scope and evidence checks; this validates recovery eligibility,
not complete candidate coverage or live proposal acceptance. The final complete
backend run (`final-backend-serial-9.log`) subsequently passed all 616 tests.
Runtime API v72 / worker v85 readbacks verified the combined code. Source
`9bff1c8e6f8f07a4d985f3fe7d6bb09e641f2ad7` passed
[Pages workflow 39565436678](https://github.com/salahassi/tenders/actions/runs/39565436678),
including its checks and publication. Hosted smoke checks returned HTTP 200
for API health and HTTP 401 for unauthenticated bootstrap and worker calls.
These release checks do not replace the pending real Word acceptance.

At the historical 07:17 UTC checkpoint, two analysis jobs had succeeded and the
third had entered bounded repair. Its OpenAI request was accepted at 07:15 and
retrieved through the saved remote ID. The earlier workspace reservation wait
was distinct from a provider HTTP 429.

That earlier release passed **575/575 backend tests** in one run (40 files,
185.82 seconds), **192/192 frontend tests**, both package typechecks/builds and
Deno checks. API v70 / worker v83 readbacks matched 26/32 files. Its new service
RPCs denied anon/authenticated execution. Source `00d3069` was pushed to main;
GitHub Pages workflow `39561029126` passed its checks and publication. Those
release facts remain historical evidence, superseded for the backend by the
subsequent runtime releases and regression results above.

At 07:15 UTC, the additive `model_continuation_queue_fairness` migration was
applied. `MODEL_IN_PROGRESS` alone no longer gives every graph continuation
poll-first priority: that priority requires the same job/workspace's reserved
accepted remote request. New phases follow the existing proposal/assessment
alternation; leases, locks, retry eligibility and provider Retry-After stay
unchanged. The other assessment that occupied the slot completed successfully.
The queue/collection suite passed 27 tests, including six new fairness cases;
13 release-command tests and typecheck passed. The combined 575-test run passed.
At that checkpoint, the release allowlist included all five October 21 patches.

The October 20 trial had failed with only one verified analysis part. Its 16,384
token ceiling came from the application's default execution profile for a
single verification/repair response, not an account quota or demonstrated model
maximum. The changes below address those blockers without declaring the live
proposal journey successful.

P5/P6 implementation: partition large claim verification into durable content
batches plus a separate whole-candidate coverage/consistency check, including
candidates without requirement IDs. Completed batches are reused; merged claims
retain exact citations and semantic repair. Provider responses keep their original
limits while the internal merged report has a separate bounded schema. Normal
failover must finish before a corrective verification phase begins; a retained
report cannot bypass an accepted pending request. Remote resumption is scoped
to its durable phase, preserving same-phase changed-input checks. No writer
budget is reset.

A private, authenticated GET-only diagnostic retrieved Google's actual error for
an existing accepted Gemini request. Both with and without the API revision
header it returned HTTP 400 / invalid_request: "There was a problem processing
your request. You will not be charged." This is a retrieval error, NOT proof of
a terminal interaction state or zero measured usage. Google's documented issue
reports include later retrieval of affected IDs. The implementation retains
accepted IDs and unknown usage, uses GET-only reconciliation with an hourly
backoff for that exact error, and selects standard transport for new phases.
The diagnostic sent no generation and its temporary entrypoint was removed.
Gemini's internal cause remains unproven. The actual analysis envelope and schema
match the documented contract; separate latent adapter defects were fixed:
provider-default reasoning omits the unsupported `none` thinking level, and
JSON-only mode consistently omits the native schema in both transports.

An accepted OpenAI request belonged to a stale blocked assessment job and kept
the workspace's reservation occupied. Orphan reconciliation now releases that
local reservation while retaining GET-only retrieval and usage accounting. The
real orphan was subsequently reconciled with 4,569 input / 4,594 output tokens;
it was not regenerated. The original trial resumed with an audit record and
unchanged writer budgets. One real corrective analysis completed with 13,926
input / 12,178 output tokens, then proceeded to verification.

The phase reservation guard also now permits genuinely different phases while
an earlier accepted request has unknown usage. Same-phase changed input,
cross-job identical input and unstructured legacy callers remain protected.
Healthy queued/in-progress responses become eligible for GET polling after
30 seconds, allowing the next minute's cron tick to process them. Network/429
errors retain their original 60-second minimum and provider Retry-After.

Wire diagnostics hash the exact serialized POST body and native schema, record
safe sizes/transport/output/reasoning metadata, and link provider response IDs.
They never log prompts, schema content, headers or credentials. Hashing runs
alongside fetch; a held-digest regression protects streaming timeout behavior.

Earlier verification at 01:27 UTC passed 501/501 backend and 192/192 frontend
tests; the complete 569-test run above supersedes the earlier regression count
and resolves the later intermediate timing/assertion failures. Security advisory
categories remain unchanged. Temporary authenticated worker diagnostics were
removed after capturing a standard Gemini verification POST HTTP 400 /
INVALID_ARGUMENT: "Request contains an invalid argument." No field detail was
returned. The earlier API v69 / worker v82 deployment is superseded by v70/v83.

The deployed Gemini adapter now converts the canonical schema to its native
supported subset, preserving object shape, required fields, numeric limits and
supported enum/union/reference constructs. String constraints and nested array
bounds remain enforced by the complete local validator rather than expanding
the provider decoding grammar. Unsupported structural keywords fail locally.
The change covers both standard and background payloads; JSON-only mode omits
the native schema. The real verifier schema decreased from 2,732 to 2,043 bytes.
The 178 focused payload/schema tests passed. At 07:08 UTC, a real Gemini
`verify_grounding` standard request on worker v83 returned HTTP 200 / STOP
with 5,646 input and 3,182 output tokens. Its wire diagnostic confirms the
2,043-byte converted schema and provider-default reasoning. Local validation
rejected a source quotation (`EVIDENCE_REFERENCE_INVALID`), and failover
continued. This proves the deployed payload can execute, not acceptance of
that assessment or the complete proposal. Google's generic earlier 400 does
not identify which original schema constraint it rejected.

At 07:21 UTC, Gemini also completed a real content-verification batch for the
original RFP trial: HTTP 200, 5,351 input / 2,953 output tokens, and local
validation `SUCCEEDED`. This is stronger evidence than transport success alone;
the remaining batches and full proposal journey still have to complete.

At the earlier 01:12 UTC acceptance checkpoint, three scoped reports
were accepted for the corrected third analysis part. Its fourth report exhausted
the corrective verifier allowance. Private inspection found its 51 claims and
source quotations valid, with zero semantic findings, but BOQ row labels rejected
by the immediate-adjacency numeric guard. A conservative table-row repair and
batched retained-report recovery are now deployed. The unchanged retained report
passes its 51 exact claims with zero semantic defects. A targeted audited resume
reopens only its blocked graph/job/plan; all budgets and checkpoints are unchanged.
New Gemini standard requests also returned HTTP 400 / INVALID_ARGUMENT during
generation, so transport fallback alone did not solve provider execution.
Complete analysis, Word download and inspection remain pending. No successful
end-to-end acceptance is asserted.

Further real-trial inspection found a verifier taxonomy error: two statements
about absent supplied company evidence were labeled supported company facts
with no references. The deployed correction treats missing factual support as
an explicit blocking semantic defect for bounded writer repair, preserving the
original report and prohibiting unsupported factual acceptance. It does not
whitelist disclaimer phrases or reset writer budgets.

Downstream evidence preparation now retains complete already-selected immutable
RFP blocks (at most 12,000 characters each), preserving headings, qualifications
and table row context. Five targeted tests passed, including unchanged analysis
request identity and Company Knowledge selection; all eight real BOQ citations
validate against the restored downstream context. This change is included in
API v70 / worker v83.


At the 06:52 UTC continuation check, the original trial had two successful
analysis jobs and one blocked job. The plan is running at revision 50 with
evidence revision 93; its existing scoped refresh confirmed the frozen proposal
inputs remained identical. Earlier resume SQL revisions must not be replayed.
The final BOQ row guard now also rejects malformed numeric boundaries before a
page break. All remaining real row labels 9–18 validate unchanged; 49 focused
grounding/aggregation tests, typecheck and diff checks passed. An intermediate
full run encountered two timing failures and three assertions during unfinished
edits; the subsequent complete 569/569 run passed. No complete Word output is
asserted.

The reviewed deployment command now includes all four October 21 patches in
chronological order and requires both new recovery RPCs before deployment.
Thirteen release fixtures passed, including interrupted transaction/resume and
connector-applied migration idempotency.

At 06:59 UTC, the early-repair integration suite passed 47/47 tests: blocking
validated batches stop further requests for the old candidate, later accepted
requests are retrieved first, and complete coverage is independently revalidated
before accepting a result. Separate repair-only artifacts cannot be accepted as
complete reports. Existing writer budgets remain bounded. These changes passed
the final full suite and are included in the verified API v70 / worker v83
readback. The targeted audited resume of the remaining analysis job preserved
its writer/correction budgets, completed checkpoints and usage history. It
recovered the retained report, derived two blocking missing-evidence defects,
and stopped requesting further verification batches for that old candidate.
The new candidate must still pass complete verification before acceptance.

## October 20 — paid-model acceptance and runtime recovery

Current acceptance result at 22:25 UTC: **incomplete, not a successful RFP-to-Word
journey**. The real trial has one completed analysis part out of three. A
corrective verifier response for another part reached its 16,384-output-token
limit; the remaining part has genuine semantic findings after citation checks.
The plan is stopped at its existing correction limit, with original analysis,
provider IDs and usage retained. No budget was reset and no finished proposal,
business approval, submission or DOCX download is asserted.

Trial usage, counted by unique provider_usage rows: OpenAI gpt-6-luna six requests
with 102,379 input / 58,213 output tokens; gpt-6.1-sol eight requests with 121,445
input / 113,406 output tokens. Four accepted Gemini requests still have unknown
usage after HTTP 400 on retrieval. Poll activity rows are not additional
generations. No dollar total is inferred. No new opportunities were recorded
during the observation window beginning 20:25 UTC.

Remaining P5/P6 acceptance work: reduce or durably batch large verification
reports within the configured output profile; address Gemini accepted-request
retrieval without duplicating unknown work; then complete planning, drafting,
commercial missing-input handling, review and real Word inspection. The Owner's
model routes, credentials, profiles and original RFP remain unchanged.

Private inspection of the rejected corrective report found four missing numeric
matches were actual BOQ row identifiers immediately preceding the exact cited
text. Grounding now checks explicit English/Arabic item labels against that
adjacent label in the same source and requires a unique exact citation. It does
not use row numbers as support for quantities, prices, dates or other numeric
claims, and does not alter the verifier's semantic findings. Six fixtures cover
valid labels, Arabic digits, wrong/nonadjacent/ambiguous labels and invented
quantities. Worker v71 is ACTIVE and all 31 files match the submitted source.
The original real corrective response was rechecked locally against its frozen
evidence: all 68 claims passed structural/citation validation, while four
semantic defects remained for correction. This required zero external requests
and did not alter the stored response or accept the proposal. All **427 backend
tests** passed in one run, along with typecheck/build and both Deno checks.
Frontend remains at 192 passing tests with unchanged code since its verified
Pages release. Source `b45659fcfa9d65e0634015d516b36d778012cbb8` passed
[Pages 39508113535](https://github.com/salahassi/tenders/actions/runs/39508113535)
including typechecks, Deno checks, all tests, build and publication. Published
index, entry JavaScript, runtime and stylesheet match the local build. Final
runtime is API v62 / worker v71; service-only recovery permissions are intact
and the security advisory categories are unchanged. Code/release verification
is complete; the failed real end-to-end acceptance described above remains open.

Source observation exposed a separate local-capacity bug: automatic source
failure handling marked MODEL_RATE_WAIT as blocked, while the recovery helper
assumed generation had already scheduled it. The new additive
`source_model_capacity_recovery` migration schedules a one-minute retry without
incrementing outage failures or sending an outage notice, preserves explicit
provider retry times, and repairs only inactive non-canceled blocked capacity
jobs with an audit record. Source and independent discovery regression tests
cover reclaiming the same job with no outage notification. Verification and
deployment: all 421 backend tests passed in one full run, with backend typecheck
and build. The migration is applied; the real Aramco collection job moved from
blocked to retry_wait / MODEL_RATE_WAIT with an audit entry. Existing login,
browser-rendering and non-listing source blockers remain distinct.

Follow-up at 21:58 UTC: published source `4e6faacad7f55deeb6b8eac526fbc09fb4ed8f64`
passed [Pages 39502080808](https://github.com/salahassi/tenders/actions/runs/39502080808),
including all 415 backend / 191 frontend tests. API v61 / worker v68 add
content-free evidence-failure diagnostics. One actual analysis part completed
verification, writer correction and verification again: a reported requirement
count was corrected against the stored requirements. Another verifier supplied
a quote absent from its cited evidence; the guard rejected it, correctly.

P5/P6 follow-up implemented: retain a schema-valid, policy-safe invalid verifier
report privately and allow exactly one corrective verifier result for that
candidate. Original analysis, evidence validation, usage history and prior
candidate budgets remain intact. The corrective request must fix its report,
retain justified unsupported findings and quote exact evidence; a second invalid
report stops for review. This does not accept unverifiable output or reset an
exhausted writer budget. Activity distinguishes local evidence/coverage failure
after HTTP 200 from provider request rejection. Two real PostgreSQL/LangGraph
fixtures prove successful correction and terminal failure, each with one writer
and one corrective report. Policy-blocked output cannot enter the correction
cache. Focused 82 backend tests and typecheck passed; frontend 192 tests passed.
Runtime API v62 / worker v69 are ACTIVE. The QA trial was resumed with explicit
audit entries after deployment, preserving writer results, original verifier
budgets and request history. Its first corrective report was accepted as an
OpenAI background request; completion remains pending. Full backend regression
passed 397 tests, with 22 interrupted by 30-second fixture/test timeouts; all 22
passed in an isolated rerun after closing the idle browser (419 total). Both
package typechecks/builds and Deno entrypoint checks passed. New frontend
publication and live corrective acceptance remain pending. The real three-part
trial is still incomplete; no complete proposal or DOCX acceptance is claimed.

Source `1a3f5aeadc55a67177713b503da09f881b33611d` passed
[Pages 39505405656](https://github.com/salahassi/tenders/actions/runs/39505405656),
including a clean 419 backend / 192 frontend test run. Runtime readback matched
all 31 worker and 26 API files exactly. The corrective verifier report completed
but failed numeric evidence validation; its one-result allowance was not reset.
Worker v70 additionally retains policy-safe rejected corrective reports in the
private graph store for diagnosis, without recursively correcting them. A
GET-only replay was audit-requested with the exhausted budget preserved. The
other incomplete analysis part is now processing; no finished Word is claimed.

Source/capacity release `3afaffc3828b9975a373746eed041eb28310cc79` passed
[Pages 39506563063](https://github.com/salahassi/tenders/actions/runs/39506563063),
including 421 backend / 192 frontend tests. Hosted source recovery has zero
non-canceled jobs blocked solely on MODEL_RATE_WAIT; the service-only failure
RPC still denies anon/authenticated execution. Authenticated Chromium observed
the original attachment, optional company knowledge/templates, disabled
duplicate generation and current processing state. Model activity loaded 25
linked rows, showed local-validation failures and GET-only polling distinctly,
and had no document overflow at 1440px or 390px. This is hosted UI smoke evidence,
not full proposal/export acceptance.

P6 / stages 5–7: Owner configured three paid task models and requested a real RFP
journey with source/usage observation. The original confirmed file is unchanged.
The earlier legacy plan was canceled through the authenticated UI, preserving
history; a new trial uses the saved task catalog. The Owner explicitly authorized
OpenAI processing of this exact extraction during the trial. No secret, route,
model capability, business approval or QA role was changed.

Hosted acceptance exposed and corrected the following issues:

- LangGraph initialization wrote disabled tracing flags to Supabase's immutable
  process environment. Unset/disabled flags now need no write; inherited enabled
  tracing still fails closed if it cannot be disabled. Content-free exception
  locations diagnose runtime faults without exposing provider/customer content.
- Ordinary confidentiality obligations in generated analysis triggered a generic
  keyword block. Storage, authorization, runtime and upload checks now distinguish
  obligations from explicit classification labels. Credential/contact checks,
  content authorization and grounded evidence validation remain enforced.
- A failed GET of an accepted background request was recorded as skipped with
  settled but unmeasured usage. It is now a failed retrieval; unknown usage stays
  reconcilable by throttled GET without another generation. Existing affected
  records retain their request IDs and error history. Activity explains request
  duration, repeated usage records and the difference between polling/generation.

- An occupied model request slot inherited the outage backoff, delaying other
  analysis parts for an hour. Catalog reservations now identify that as a local
  one-minute wait; accepted requests and provider Retry-After remain intact.
- Real verification reports exceeded output limits. Compact verification sends
  all content units once, requests concise supported findings and exact coverage
  IDs, and persists its format. Existing accepted requests retain their original
  input while new verification requests avoid triple copies of the candidate.

Local evidence: **415 backend and 191 frontend tests** passed across the final
runs. One full backend run completed 410 tests while the five evidence tests hit
a fixture-initialization timeout; those five passed in an isolated rerun. All
compact graph/grounding/generation fixtures passed, including preserving an
accepted legacy request's input and pinning compact input across polls. Both
package typechecks/builds and Deno API/worker checks passed. The worker/database
reconciliation fixture retains unknown usage after HTTP 400, obtains measured
usage by GET, performs only one POST and never fabricates task completion.

Runtime: API **v60**, worker **v67** ACTIVE; migrations
`confidentiality_requirement_labels`, `accepted_request_observability` and
`model_capacity_wait` applied.
At 21:37 UTC, all three real OpenAI analysis results passed structural/evidence
validation and entered durable graph storage, including two recovered from their
original provider requests after the local policy fix. No repeated generation
was needed to recover them. Compact verification is running on the real trial. Grounded review, remaining analysis, full proposal/DOCX inspection,
frontend publication and end-to-end acceptance remain in progress. Gemini accepted
requests but subsequent GET returned HTTP 400; no zero-usage assumption is made.

## October 20 — automatic provider request handling

P1/P2/P5 / stages 4–7: replace the capability-assertion checkbox with automatic
request handling and an advanced standard-request override. Provider adapters
determine which APIs can resume requests. Only an explicit structured HTTP
400/422 background-feature rejection permits retrying that same model with a
standard request; the failed attempt and nullable usage are settled before a
fresh lease. Both attempts retain separate activity entries. A service-only,
lease-checked RPC reads account/model-scoped observations from the existing ledger,
with a 24-hour lifetime and configuration-snapshot reset. Accepted remote IDs
remain pollable even if the override or capability observation changes.

Local verification: **409 backend / 189 frontend tests (598 total)** passed,
along with both typechecks/builds and Deno API/worker checks. Actual graph
fixtures passed for OpenAI and Gemini; the legacy worker also completed its
same-model standard retry across two leases. Isolated Chromium exercised the
actual component's automatic default, advanced override save/reload, restoring
automatic handling and desktop/390px layouts with no page errors or overflow;
both screenshots were inspected. No paid inference was used for these fixtures.

Runtime deployment: source **`b764ea2bac744f6413a40c63928b1015f7187500`** is on main.
The connected Supabase release recorded `automatic_model_transport` as migration
**`20261020200630`**. API **v56** and worker **v58** are ACTIVE; all **26/31**
reachable source files respectively match the submitted source. Health is 200;
anonymous bootstrap and worker invocation are 401. The new RPC denies anon and
authenticated execution, permits service role and rejects a stale lease in the
hosted database. Security-advisor counts remain the previous 9 private-table
INFO / 22 authenticated-definer WARN / 1 Auth WARN. Scheduler heartbeat advanced
after deployment with scheduling enabled. Authenticated catalog reads succeed;
the QA Editor receives the expected 403 on Owner-only setup metadata.

Frontend [Pages 39489414347](https://github.com/salahassi/tenders/actions/runs/39489414347)
passed all 598 tests, typechecks, Deno checks, build and deployment. Published
index, entry script, Settings bundle and stylesheet match the tested build.
Authenticated hosted Chromium verified catalog reads, reload, desktop/390px
layouts with no overflow or page errors, QA Editor editing denial and reopening
the existing RFP plan with duplicate generation disabled. Owner override saves
were exercised in the isolated actual-component browser and database tests;
the hosted browser did not impersonate an Owner or change configuration.
During verification the user had configured three models and enabled new-work
admission. This release did not edit routes, provider selections, secrets or
admission; no live inference was initiated for its smoke checks.

Status: implementation, local verification, runtime/frontend deployment and
hosted UI smoke verification complete. Additive migration
`20261020195225_automatic_model_transport.sql` precedes compatible runtime and
frontend deployment. Tests cover exact feature rejections, negative quota/auth/
schema/gateway cases, same-target continuation in the actual graph, distinct
attempts/usage, accepted-request resume and browser-editable override defaults.
Live inference, model routing edits and new-executor admission are not part of
this UX/transport fix; paid-model acceptance remains a separate gate.

## October 20 — unified execution implementation and compatible release

P0–P5 / stages 4–7: canonical task schemas, eight API adapters, configurable
connections/models/task routes and profiles, target-aware attempts/usage and
whole-text grounded verification/correction are implemented. LangGraph 1.5.1,
checkpoint 1.2.0 and Core 1.2.18 use lease-bound private database persistence,
pending writes, immutable result caching and atomic domain commits. Inherited
external tracing is disabled. Old workers skip graph jobs; a compatible worker
can drain both executors. New-work admission is initially disabled.

The new [runbook](MODEL_EXECUTION_RUNBOOK.md) documents configuration, execution,
rollback, recovery and the paid-model acceptance handoff. New metadata and graph
state are included in hashed workspace backup; isolated restore disables model
connections/admission and cancels active work. Explicit grants/RLS remain in
each new migration. API and Pages deployment workflows now check both functions;
the backend deployment workflow also deploys/verifies the worker.

Local evidence: **386 backend tests / 33 files** passed, followed by **15 targeted
catalog/batch/recovery checks** after the final command-dispatch fix, **41 existing
database/API integration checks**, and **18 graph/catalog checks** proving no
external tracing network request even with inherited tracing flags enabled; **187 frontend
tests / 34 files**, both package typechecks/builds and Deno checks for API/worker
passed. The actual graph executor passes native pending-request resume, same-
provider fallback, bounded correction, early repeated-defect termination,
old-worker exclusion and admission rollback fixtures. A full isolated proposal
pipeline completes all stages and prepares a draft export without custom
company/template data. Empty-reference generic sections now carry their original
notice context instead of failing data authorization. Browser fixture checks
passed model creation, same-provider ordering, profile/admission saves, reload
persistence, 390px layout and absence of browser errors; desktop/mobile screenshots
were inspected. Synthetic fixture output is not live business acceptance.

Deployment update at **18:26 UTC / 21:26 Riyadh**: all additive migrations
are applied. Fresh connector requests accepted the unchanged graph RPC/domain
and recovery SQL after the earlier MCP `Invalid or expired requestState` errors.
No new secret, permission relaxation, database reset or queue reset was needed.
The request-state error came from the connector confirmation path; its exact
server-side cause is not proven by the client response.

Hosted migrations: `20261020155016` (`model_catalog_and_task_routes`),
`20261020155037` (`model_target_identity_and_execution`),
`20261020160954` (`durable_model_graph_storage`),
`20261020181506` (`durable_model_graph_store_rpc`),
`20261020181537` (`durable_model_graph_domain_commits`) and
`20261020182128` (`model_graph_recovery_and_retention`). The three graph parts
are the exact statement boundaries of local `20261020143042`. The optional
release runner now recognizes all three parts as complete and rejects incomplete
out-of-order history, so a later release does not replay their DDL. All **8 release-runner tests**
passed, including the actual completed split-history shape.

Runtime source `5e3e088e5977facd245b3119a17053451b7acf1a`: API **v54** and
worker **v56** are ACTIVE. All **26 API / 31 worker reachable files** returned by
Supabase match the submitted source exactly. Health returns HTTP 200; anonymous bootstrap and worker requests return 401. Minute
worker dispatches return 202; the 18:26 database heartbeat confirms background
execution. New catalog tables have member-read RLS and no anonymous grants;
private graph tables deny browser reads, and claim/store/commit RPCs remain
service-role-only. Original RFP hash is unchanged. New-work admission remains off
for the staged paid-model acceptance; existing jobs retain legacy execution.
Frontend merge **`bacebc98f95ea2c80f8ee6b17fce42d1d988e48d`** is published.
[Pages 39475172310](https://github.com/salahassi/tenders/actions/runs/39475172310)
passed **395 backend / 187 frontend tests (582 total)**, both package typechecks,
Deno API/worker checks, build and deployment. Backend build/typecheck also passed
locally after the final runner change. Published index, main/runtime scripts,
stylesheet and Settings bundle match the tested build byte-for-byte.

Authenticated hosted Chromium verified all four catalog reads (200), the
Owner-only setup endpoint denial for the existing QA Editor (403), disabled
Owner editing controls, settings reload, desktop/mobile layout and reopening the
existing RFP plan with duplicate generation disabled. There were no page errors.
The persistent browser initially showed cached legacy settings; cache-disabled
reload loaded the verified new bundle. Owner configuration saves were exercised
in the isolated actual-component browser tests and database/API tests, not by
impersonating an Owner in the hosted browser. No synthetic business records,
new external model requests or replacement originals were created for this smoke
check. The paid-model canary and new-executor admission remain pending; this
compatible release does not claim a live graph or complete Word acceptance.

Historical fallback [workflow 39457435238](https://github.com/salahassi/tenders/actions/runs/39457435238)
stopped at its Actions credential check and deployed nothing. This release instead
used the already connected Supabase tools successfully. `SUPABASE_ACCESS_TOKEN`
is needed only if choosing that separate Actions deployment path; it is not a
new application requirement or a blocker for this connector release.

Security-advisor counts remain 22 pre-existing authenticated-definer warnings,
one Auth warning and nine intentionally private no-policy informational entries.
No new exposed graph RPC or table was found. At 18:36 UTC scheduling remained
healthy, with zero graph admissions and zero versions for the existing trial.
Failure-email history was 46 sent (last 17:36 UTC, before runtime deployment),
with one pending grouped failure summary; notification preferences were not
changed or disabled by this release. Full fresh MAIN-01–14 and E2E-01–10,
actual inference quality and downloaded Word acceptance remain pending the
Owner-provided paid models. The complete isolated pipeline and browser fixtures
are implementation evidence, not a live business proposal pass.

## October 20 — staged release and paid-model acceptance order

The Owner clarified that the application must keep working throughout the model
upgrade, and that paid models will be added after the implementation is ready.
The full main-process test then starts from the beginning. This ordering
supersedes the earlier same-day acceptance target recorded below.

Updated [MODEL_EXECUTION_PLAN.md](MODEL_EXECUTION_PLAN.md) links P0–P6 to release
gates R0–R7 and defines MAIN-01–14 alongside E2E-01–10. The plan preserves current
records, approvals, routes, queue leases, accepted remote requests and legacy
executors; additive database changes precede compatible API/worker/frontend
releases. It includes per-migration explicit GRANT/RLS checks for the October 30
Data API change, canary admission, rollback compatibility, the paid-model setup
handoff and protected evidence for actual downloaded artifacts.

Status: **planning update only**; no runtime, production schema, model settings,
credential or billing change. The update passed **30 relative-link checks**,
`git diff --check`, **330 backend tests / 29 files**, **183 frontend tests / 33
files**, and both package typechecks/builds. Plan source
**`19ad73e901328a5bf57f6f6c9cd798838c1d84db`** is published on main;
remote commit/tree and plan/checklist bytes match local source. No deployment
workflow ran for this documentation-only commit, as expected. Main-process and
paid-model acceptance remain unperformed
for the planned implementation; prior checks are retained as historical evidence.

## October 20 — unified model execution implementation plan

The Owner requested a complete plan for structured requests/results across every
model task, per-task multiple-model routing (including models from the same
provider), grounded validation/correction, LangGraph, configurable output/reasoning
profiles and real RFP-to-Word acceptance. The new
[Model Execution Plan](MODEL_EXECUTION_PLAN.md) maps packages P0–P6 to the original
M1–M6 milestones, stages 1–7 and AT01–AT30. Its precedence decisions are recorded
in [DECISIONS.md](DECISIONS.md); the original specification links to the extension.

Implementation status: **planning documentation only**. Current model contracts,
provider identity/ledger, generation validators, Word renderer and Decimal
calculator were inspected. Official provider, LangGraph and Supabase references
were checked. No runtime, model configuration, credential, permission or billing
change is part of this documentation release. LangGraph is a planned, compatibility-
gated library inside the existing worker, not an extra hosting dependency.

Read-only hosted baseline at **2026-10-20 11:17 UTC / 14:17 Riyadh**: the authorized
existing RFP trial remains in analysis with `MODEL_ROUND_EXHAUSTED`, one completed
step, thirteen queued leaves, eleven split parents and **zero proposal versions**.
Recent sent requests from Gemini, Groq and z.ai returned 429. P0 prioritizes the
actual draft/download/regeneration journey on October 20 without waiting for the
full refactor. E2E-01–E2E-10 distinguish real artifacts, isolated fixtures,
provider availability and final business approval; no live proposal pass is claimed.

Verification: all **43 relative documentation links** checked successfully;
**330 backend tests / 29 files and 183 frontend tests / 33 files** passed, with
both package typechecks/builds and `git diff --check`. These are existing
regression checks, not implementation evidence for the planned features.
Published plan source **`50307a68b88409571071d1012332bc8c03dc076d`** is on main;
the GitHub commit/tree and returned bytes of the plan, checklist, specification
and decisions match local source. The documentation-only commit has no Actions
deployment run, as expected from the workflow's path exclusions.
Runtime remains API v53 / worker v55. Documentation-only publication does not
require or claim a new application deployment. Earlier dated entries below
remain historical evidence; the new plan does not mark their open acceptance
items complete.

## October 20 — processing independent of the request connection

The Owner requested durable background processing and confirmed there is no additional server. Deployment stays on Supabase; a permanent external worker is **not** provisioned or claimed. The authenticated worker acknowledges dispatch with HTTP 202 and registers processing with `EdgeRuntime.waitUntil`. Its database job/lease remains authoritative after the HTTP caller disconnects. Model work has a 130-second invocation budget, leaving headroom within the documented 150-second free Edge runtime. A fresh attempt receives at least 90 seconds, up to 120 seconds when invocation time allows; otherwise the existing durable continuation resumes in a fresh invocation. This is bounded background execution, not unlimited runtime.

Gemini and OpenAI Responses accepted request IDs are persisted and retrieved across invocations. Transient polling failures/429s retain the same pending request and do not trigger another provider while its result is still unknown and retrievable. Definitive terminal failures preserve measured usage and permit failover. OpenAI native background mode is now implemented independently of model names, with stored results deleted after successful persistence; actual OpenAI acceptance remains unverified because no key is configured. New remote checkpoints bind the configured project as well as provider/model/prompt; legacy checkpoints retain their prior compatibility. Canceled outputs are only reconciled for usage, never published.

Synchronous chat-compatible providers and Claude stream responses when called by the detached worker. A 90-second idle timer resets on received stream data, while the independent bounded invocation deadline remains. SSE assembly handles fragmented UTF-8/CRLF, recorded usage and terminal markers, excludes reasoning text, rejects oversized/error responses and does not accept a cut stream as a complete result. Unsupported real provider responses still follow the recorded failover path; no model-specific name, artificial successful output or invented usage is introduced.

Verification: **330 backend tests / 29 files and 183 frontend tests / 33 files**, both package typechecks/builds and Deno entrypoints passed. The focused transport/worker/PostgreSQL cases cover a 100-second active stream, 90-second idle, hard ceiling, disconnected caller, same-request Gemini/OpenAI polling through a 429 and lost lease, transient polling failure, terminal failover and existing usage/content/identity guards. Hosted migration `20261020100949` is applied; API **v53** / worker **v55** are ACTIVE. Remote-request RPCs remain service-role-only; health returns 200 and anonymous jobs/worker requests return 401. All **38 reachable runtime files** match the tested source exactly. Security-advisor categories and counts are unchanged (4 private-table INFO, 22 existing authenticated-definer WARN, 1 password-protection WARN). Minute dispatches at 10:11 and 10:12 UTC returned HTTP **202** without timeout, with a later database heartbeat confirming background execution. Authenticated Chromium reopened the same saved plan with no page errors or horizontal overflow; duplicate generation remains disabled. Source `bd0cf5ed2b5bd3686c4b813d78f3ee00f14e736e` is published to main; [Pages 39406261935](https://github.com/salahassi/tenders/actions/runs/39406261935) passed both build and deployment, including all **513** application tests. No additional processing email was sent: the count remains 45, last sent October 19 at 17:35 UTC. The authorized QA browser was closed cleanly; its account remains for the pending real proposal trial. The real proposal still has one completed analysis leaf and thirteen queued leaves; live configured providers are under recorded cooldowns. No Word output is claimed.

## October 19 — environment-browser RFP trial

The Owner explicitly authorized a temporary QA user and use of the existing mismatched opportunity/RFP for this trial. This supersedes the earlier requirement to relocate the file. A temporary Editor joined through the normal invitation, email confirmation and password sign-in flow; no administrative provisioning endpoint was deployed. Headless Chromium in the project environment authenticated against the published application. The original 21-page PDF downloaded through the application's Storage route, with the exact stored SHA-256 verified. Extracted text retained all 21 page markers; its requirements, SLA table and 18 BOQ items were checked against the original. The Editor confirmed extraction and created proposal plan `68443ce9-3908-41f7-a309-110f230080c9` through the UI without a template or company files. No buyer metadata, rates or company claims were fabricated.

The trial exposed a roughly 66-second workspace load caused mainly by sequential pages of around 1,800 historical jobs, and proposal work waiting behind automatic assessments. Operational history now requests bounded 500-record pages (other resources remain at 100), retaining all cursors/history and membership/RLS checks. The queue alternates eligible proposal work with waiting assessments while preserving accepted remote requests, waiting source priority, provider retry times and one live workspace lease. Model content checks now match the existing storage check for the word Confidential; ordinary confidentiality requirements do not incorrectly match that word. Explicit per-content provider authorization remains required.

Verification: **295 backend tests / 27 files and 183 frontend tests / 33 files**, both package typechecks/builds and Deno entrypoints passed. The migration is deployed; authenticated worker-claim access remains denied and service access remains granted. API **v47** and worker **v49** are active; all **36 reachable runtime files** match tested source exactly. Public health returns 200, unauthenticated API and worker calls return 401, and security-advisor categories are unchanged. A real request under the QA browser session returned 500 jobs with a continuation cursor; the local PostgREST cap now accommodates that batch plus its lookahead row. The first proposal attempt ran and correctly stopped at `DATA_AUTHORIZATION_REQUIRED`, before provider processing.

The Owner explicitly approved both the exact RFP processing via Gemini/Groq/z.ai and PR #5 publication. The three exact-hash content grants were saved through the audited application command. Source `d6496f052bb2bd8b56805224772e6846d1f1dc05` is on `main`; [Pages run 39338756725](https://github.com/salahassi/tenders/actions/runs/39338756725) passed. The same authenticated browser's workspace reload improved from 68 seconds to 17 seconds. Permissions and publication are no longer pending.

Actual Resume saved work exposed a separate legacy `USAGE_REVIEW_REQUIRED` guard: unrelated historical unknown usage blocked a proposal that had not been sent. The follow-up migration delegates ambiguous-call checks to provider reservation when automatic routing is enabled. Active reservations and legacy manual policy still block resume; same-provider/input duplicate protection and recorded unknown usage remain intact. Four PostgreSQL cases cover automatic/manual mode with unknown/reserved usage. All 71 generation/routing/continuous-model checks passed. Hosted migration `20261019231234` is applied, with the private security-definer ACL unchanged. Actual browser Resume returned HTTP 200 and queued the same saved plan; the scheduler resumed it without duplicate plan creation. The resumed plan is waiting automatically for provider availability; actual generation and Word download remain pending. No generation success is claimed. The temporary QA Editor remains active for this trial; credentials/customer files stay outside the repository.

Provider timing follow-up: live z.ai attempts consistently ended at the application's 20-second timeout. Automatic rounds now share a 90-second request allowance among actually configured providers whose cooldown has elapsed, so a sole available provider is not shortened by unavailable alternatives. Background polling keeps its existing 20-second bound. Timeout/network classification is recorded without raw errors or customer text; ambiguous usage remains unknown. Fake-clock transport tests cover a 25-second valid proposal response, a timed-out provider followed by success, all providers timing out, and the existing single-provider diagnostic. No provider-specific model name or billing gate is introduced. UI copy distinguishes active preparation and provider waiting from readiness to start.

Follow-up verification: **302 backend tests / 27 files and 183 frontend tests / 33 files** passed; both package typechecks/builds passed. Both Deno entrypoints passed with the repository CI version 2.9.6. API v48 and worker v50 are active. All 36 reachable runtime files match the tested source. Source `0ad8ce97a168c8b46464491327f0b652d7697e84` passed [Pages 39341417085](https://github.com/salahassi/tenders/actions/runs/39341417085). Public index, main JavaScript, stylesheet, runtime and opportunity bundle match the tested build. Health returns 200; anonymous jobs and worker calls return 401. Actual hosted Chromium shows automatic waiting and disables duplicate generation. No further failure mail was sent: 45 historical processing messages remain; one summary waits until the daily interval on October 20. Subsequent provider results remain pending.

Authenticated mobile inspection found a real 481px horizontal overflow at a 390px viewport, caused by the global navigation/actions row. The small-screen header now wraps its action groups while preserving Refresh and Sign out. The authenticated browser preview fits both 390px and 320px without horizontal overflow, retaining the visible Refresh/Sign out actions and disabled duplicate generation. Frontend typecheck/build and all 183 tests passed again after the CSS change. Backend remains the unchanged 302-test source verified above. Source `f36e0d4e49982e969cbe8fa290ec73e3f9e43bb4` passed [Pages 39342635409](https://github.com/salahassi/tenders/actions/runs/39342635409), including the full checks and deployment. The public index/main/CSS/runtime bytes match the tested build. Authenticated hosted reload at 320px now has no horizontal overflow; the pre-reload cached page still had the old stylesheet. Actual proposal generation remains pending provider availability.

Live proposal processing resumed automatically at 23:45 UTC. z.ai returned real HTTP 200 responses after **59.7 seconds** and **84.7 seconds**, with measured input/output of **3,789/4,096** and **3,738/4,096** respectively. Both were truncated, proving that the previous 20-second timeout hid actual provider responses. Automatic routing then hid the measured truncation behind MODEL_ROUND_EXHAUSTED, preventing the saved generation step from using its existing split/repair path. The correction preserves the measured output error for persisted proposal tasks after trying every provider; source/probe/assessment exhaustion behavior is unchanged. A database + real model adapter fixture now proves automatic truncation splits into overlapping complete source ranges and the saved plan subsequently completes; usage stays measured. Expanded output-recovery/model/generation checks pass (**68 focused tests**). Full backend verification passed **309 tests / 27 files**, both package typechecks/builds and Deno checks passed (frontend unchanged at 183 tests). API v49 / worker v51 are ACTIVE with all 36 reachable files matching source. GitHub publication and hosted split acceptance remain pending. Subsequent z.ai 429s report provider overload; availability remains external.

## October 20 — full 90-second provider attempts

The Owner explicitly requires at least 90 seconds per provider attempt. This supersedes the shared 90-second round budget above. Every generation POST, including Gemini background submission, receives 90 seconds independently. Read-only background polling retains its short timeout. If there is insufficient invocation time to start another full attempt, the leased worker checkpoints the remaining provider identities, original prompt hash, measured output error and retry windows, then releases the job for automatic continuation. Fresh provider configuration/authorization is rechecked; completed providers are not resent, unknown usage remains unknown, and the logical round counter is preserved. The checkpoint is service-role-only and rejects stale leases, cancellation, changed inputs and unknown identities. A later exhausted round can still reach the bounded split/repair path. Verification: **313 backend tests / 27 files and 183 frontend tests / 33 files** pass, both package typechecks/builds and Deno entrypoints pass. Transport tests allow a 75-second successful response and a full 90-second timeout on each provider across continuations. Database tests cover priority/round-robin order, unchanged logical round number, lease release, identity/input validation, canceled jobs and denied browser RPC access. Two long multi-step integration cases now allow 15 seconds instead of the default five; their full assertions are unchanged. Migration `20261020001729` is applied. API **v51** / worker **v53** are ACTIVE; all **36 reachable files** match tested source. New RPCs are service-role-only; security-advisor categories/counts are unchanged. Generation starts within the first 20 seconds of a worker invocation, leaving its full 90 seconds plus settlement inside the existing 120-second dispatcher deadline. The three existing trial analysis jobs were audit-rescheduled once after deployment; their failure counts, provider Retry-After and unknown-usage guards were preserved. GitHub publication and actual hosted generation/download acceptance remain pending.

## October 20 — scoped evidence recovery during the real RFP trial

The 90-second release `5c85d34b0c024eadac22f67c2e0da1159397eaff` passed [Pages 39383520652](https://github.com/salahassi/tenders/actions/runs/39383520652). During unattended production execution, z.ai reached an actual **90,692ms** timeout, and later produced one valid analysis after **42,976ms**. Eleven measured truncations followed the persisted split path; one leaf completed, with thirteen leaves still queued when a global evidence revision change blocked them. The RFP extraction hash/revision and company inputs were unchanged. Comparing fresh/frozen context found only classifier-only notice metadata changed (`fetched_at`, raw detail HTML hash); the workspace-wide revision guard incorrectly treated this as a changed proposal input.

Follow-up implementation checks the current proposal snapshot against every frozen proposal input before advancing its evidence revision. Only the three fields consumed exclusively by classification are omitted from that equality check. Actual RFP, buyer notice text, language, template, company evidence, rates and review changes still block stale work; the frozen context/input hash and completed steps are retained. Assessments and existing approval invalidation retain their prior guards. Generation outputs now use the already-supported 8K ceiling, giving reasoning-enabled models room to finish JSON instead of repeatedly cutting analysis/planning at 2K–4K. This remains a response bound, not a daily token quota. Verification: full backend **317 tests / 27 files** passed, then the expanded **24-test generation suite** passed including a populated migration recovery case (318 current backend tests). Frontend **183 tests / 33 files**, both typechecks/builds and Deno checks passed. Hosted migration `20261020071647` is applied; API **v52** / worker **v54** are ACTIVE with all **36 reachable files** matching the tested source. The private refresh helper is not callable by browser roles. Production recovery requeued all **13** unchanged-input jobs, retained the completed/split jobs and original frozen context, and advanced the proposal evidence revision from 57 to 77 with audit evidence. Source `790fdbee83d9fdc26ac2abe97d368f1485053c14` passed [Pages 39385855838](https://github.com/salahassi/tenders/actions/runs/39385855838), including both package checks, **318 backend / 183 frontend tests**, Deno and publication. Authenticated Chromium shows the same saved proposal actively preparing/waiting, with duplicate generation disabled and no horizontal overflow. Health returns 200 and anonymous jobs/worker access returns 401; security-advisor categories/counts remain unchanged. The recovered proposal now reaches model routing without STALE_INPUT: the first subsequent Groq attempt returned HTTP 429; z.ai is under shared outage backoff and Gemini has a recorded Retry-After. At 07:22 UTC the plan remained running/analysis, with 13 unfinished leaves (10 queued and 3 automatically retrying), one completed leaf and eleven split parents. There are still **zero proposal versions and no hosted Word download**. The minute scheduler continues with a fresh heartbeat; failure emails remain at 45, last sent October 19 at 17:35 UTC. Provider availability and completion of the real generation/download trial remain open; no finished tender output is claimed. The authorized QA account remains for this pending trial.

## October 19 — Repeated processing email incident

The Owner reported an Outlook notification burst. Production records showed 42 legacy per-job processing emails followed by three hourly grouped emails (45 accepted processing messages total); no mail was pending at investigation time. Grouping by newly affected task still repeated an already-reported model outage. The Owner's failure interval was changed from its inherited one-hour default to 24 hours with an audit event; failure alerts and review reminders remain enabled.

Implemented cause-level incident memory: additional tasks do not resend the same continuing failure; a cause can alert again after observed recovery, subject to the recipient's interval. Daily is the default for new preferences. Historical sent/ambiguous messages seed incident state, pending summaries recheck current failures and the sending interval, and claim/tick follow the same workspace lock order. Definite SMTP failures retry the same delivery; ambiguous delivery stays final. Pre-opt-in notifications are excluded. The current summary includes all active causes rather than only newly affected tasks.

Provider diagnostics also showed repeated 429/500/uncertain requests without Retry-After. A shared per-provider/model backoff now derives a 1-minute to 1-hour wait from consecutive actual failures, honors longer provider Retry-After, ignores skipped attempts, resets on a response, and leaves other providers/models eligible. This changes retry admission, not model outputs or unknown-usage accounting. Provider availability is external and is not claimed fixed. Verification: **291 backend tests / 27 files and 182 frontend tests / 33 files**, both typechecks/builds, and 23 focused migration tests pass. To work around two connector `Invalid or expired requestState` failures on the combined migration, the same tested SQL was split into four smaller migrations; they and provider backoff are deployed. Hosted versions: `20261019184106` backoff, `20261019184529` incident state, `20261019184752` preferences, `20261019184804` tick, `20261019184813` claim. All nine function bodies match local SQL hashes. Repeated live ticks produced no pending mail or duplicate sends: 45 historical processing messages remained 45. The four existing active causes are remembered; browser reads of private state and browser delivery claims are denied, and service claims are retained. Post-migration advisors show no new exposed-function warnings; the extra RLS-without-policy item is the intentionally private incident state. No extra test email was sent. API v46 and worker v48 are unchanged. A navigation test now waits for the opportunity route before clicking its proposal link, avoiding a stale-route match exposed under concurrent test load.

Published source `0e90336f87b2148fdb9e8f2fed4698a553e9ca0f`; [Pages run 39306430929](https://github.com/salahassi/tenders/actions/runs/39306430929) passed frontend/backend checks, all 473 tests, Deno checks and deployment. Public HTML and the updated Settings JavaScript match the tested local build byte-for-byte. At 18:54:49 UTC, processing-email count was still 45 with no queued/sending/retry deliveries; scheduling was enabled with an 18:54:02 heartbeat. Actual model activity from 18:42 through 18:55 showed 13 Gemini, 14 Groq and 14 z.ai wait skips without HTTP requests; one intervening Gemini request still returned 429. This verifies shared waiting in production, not recovery of the providers themselves. Hosted RFP-to-proposal acceptance remains the separate pending task below.

## October 19 — RFP-first proposal trial and usability

Hosted session follow-up: the Owner saved a new TinyFish session and run `cdb0bdb5-e244-484c-950e-40c5e1d06afc` confirmed authenticated Owner access to IIH, the uploaded RFP awaiting extraction confirmation, and zero proposals. TinyFish then reported insufficient wallet balance for another run; browser upload/generation/download remains pending. Read-only database evidence confirms the actual uploaded document is **NHCI Strategic Intelligence Platform** for **NHCI Innovation**, while its linked opportunity is the An-Najah digital-security/mobile-app expert notice. The browser report's inference of construction from the generic filename was unsupported and is not used. Preserve both records; a correctly matched opportunity is needed for the trial. The Proposals empty state incorrectly described backend connection as a future step even in a connected workspace. Its copy now describes the actual upload/review/generate path and optional templates/Company Knowledge. Verification: 182 frontend and 291 backend tests pass with both typechecks/builds. An initial simultaneous run exceeded timing limits in existing tests; separate runs with bounded workers passed without test or assertion changes. Published source `754b03e464f0b9cd971004b4f91ae74073aaa071`; [Pages run 39309224523](https://github.com/salahassi/tenders/actions/runs/39309224523) passed all checks and deployment. Public HTML and Proposals JavaScript match the local build byte-for-byte. No backend runtime or database changes were required; no hosted proposal success is claimed.

Owner requests a real RFP upload-to-download trial and preparation without custom templates or sufficient Company Knowledge. Initial hosted read-only findings: no saved templates or proposals; one RFP with extracted text but no extraction confirmation. Browser sign-in is pending; no hosted upload-to-download success is claimed.

Implemented: generation controls colocated with language/input context; direct pending-extraction review; accurate readiness stage and cloud-persistence guidance; workspace refresh when generation completes; full draft download clearly separate from final approval controls. Generation instructions require a substantive RFP response without inventing company facts; an empty knowledge collection is advisory, while actual mandatory evidence and pricing questions retain their gates. No schema changes.

Verification: **285 backend tests / 26 files and 182 frontend tests / 33 files** pass, plus both typechecks/builds and Deno entrypoint checks. The new database-backed generation test completes all sections with no templates, knowledge or rates; its model responses are fixtures. A real Chromium Web Worker packages that exact resulting export model into a 969,997-byte Word file, and canonical server verification accepts its content. Separately, 24 local Chromium checks cover desktop/mobile navigation, an actual file input/extraction, Arabic review persistence and draft download, with no browser errors or external requests. These tests do not establish hosted Auth/Storage or live model quality. The multi-page navigation test has a 15-second total allowance because lazy routes can exceed the default five seconds; assertions are unchanged.

Hosted findings: the existing uploaded RFP describes a different project/client from its linked opportunity notice. Preserve both the original file and current record; use a correctly identified opportunity for the real trial. No synthetic records were inserted in production. Hosted browser sign-in and live upload-to-download acceptance remain pending; no actual tender approval or submission was performed. Published source `8ea8bc0b028d12895b34bd4128731fef00835407`; [Pages run 39289928588](https://github.com/salahassi/tenders/actions/runs/39289928588) passed the complete CI and deployment. Worker v48 is active and all 19 readback files match the intended package; only generation.ts changed. API v46 and the database schema are unchanged. Public HTML and affected JavaScript assets match the tested local build byte-for-byte. API health returns 200; scheduling remains enabled with a fresh heartbeat. During the live read-only observation, Gemini/Groq had provider rate-limit responses and z.ai had rate-limit/overload/uncertain-network responses; Groq also had one recent successful assessment. These background assessment results are not proposal acceptance.

Verified October 18, 2026 (Asia/Riyadh). This file separates code, deterministic tests, deployment, and actual hosted acceptance. Requirements remain in [IMPLEMENTATION_SPEC.txt](IMPLEMENTATION_SPEC.txt); later [DECISIONS.md](DECISIONS.md) and the [frontend handoff](../../frontend/docs/FRONTEND_HANDOFF.md) apply. Historical investigation checkpoints remain in Git history and [INTEGRATION_TEST_REPORT.md](INTEGRATION_TEST_REPORT.md).

**The application is deployed with an active scheduler, real official collections and working Gemini inference. Full hosted proposal acceptance is still incomplete.** Full system activation, migrations, publication and tests are already authorized. Do not request the same permission or another Google login. Only Gemini is configured; optional provider credentials and actual tender costs must never be invented.

## Current release and completion results

- Runtime: API **v15**, worker **v12**, all 14 retained files each match source `a2c3bb0e7aad4092054a04ae7cf8e46184de87de`. Both Deno entry checks passed. Minute scheduling is active; source interval is six hours. Runtime hashes and migration mappings are in [DEPLOYMENT.md](DEPLOYMENT.md).
- Published PDF fix: source `2d8380ec981ab43a386e194efef0c3b1221a789f`, successful [Pages run 39080451104](https://github.com/salahassi/tenders/actions/runs/39080451104). PDF.js library handshakes no longer prematurely resolve/terminate document extraction.
- Four reviewed exact-URL public collectors are active: Jordan GTD, An-Najah, Ramallah and IsDB corporate procurement. Real scheduled collection produced **35 opportunities and 35 snapshots**: 6 GTD, 19 An-Najah, 10 Ramallah; IsDB completed with no open notices. The other 31 official directory entries remain manual destinations, not active collectors. See [SOURCE_COLLECTION.md](SOURCE_COLLECTION.md).
- Owner browser saved and reloaded the user-supplied public IIH company profile and verified it (revision 2). Its exact text and one actual Ramallah notice are authorized for Gemini. No claims of certifications, past projects, staff availability, rates or commercial approvals were fabricated.
- Tender costs now have direct dated scope-specific entry with auditable Owner approval and retry without duplicate creation. Currency is suggested from country (SAR/JOD/ILS), with tender requirements taking precedence and existing saved estimates preserved. A fixed company price list is not required.
- Owner browser exposed processing controls hidden until shortlisting. The current change exposes assessment/progress/resume/cancel for an unselected discovery and removes obsolete disconnected messages. Role restrictions and expected revisions remain intact. All 143 frontend tests/26 files and typecheck/build passed; published by [Pages 39081277000](https://github.com/salahassi/tenders/actions/runs/39081277000), source `82e9ffbd63ccb74c7e47f7bfd6f375920d67d2b4`.
- Queue migration `20261017234946` is deployed as hosted `20261017235442`. Claim hash `8cc7ff949e99c9763a476dcbe6e5a4e5`; authenticated execute false, service execute true. A follow-up covers source jobs already blocked by STALE_INPUT and all saved generation continuation stages. The follow-up is deployed as `20261018000051`; canonical file `20261017235819`, claim MD5 `9e8c911861a7c48d91fce7b7fbdfebda`, unchanged service-only grants. All 171 backend tests/21 files and typecheck/build passed. Exact content permissions remain enforced.
- Final application checks: **171 backend tests/21 files and 143 frontend tests/26 files**, both typechecks/builds passed. The private actual-metadata recovery drill also passed separately. Concurrent package runs hit the existing UI journey timing limit; the isolated final frontend run passed every test without changing timeouts or assertions. Do not count retries as extra tests.

## Actual browser and data evidence

- Real Owner TinyFish profile works. Directory filters/details, preferences/reload, navigation, Gemini configuration, automatic round robin and completed diagnostic reload are verified. Do not fabricate an account or rotate credentials to obtain another session.
- Public IIH note save/reload: run `1a853873-0f10-4149-b641-df719ece93c8`. Verification and exact Gemini content permissions: `ed2fe939-6e85-4654-bb32-0e37f63f430d`.
- Ramallah source pause/reload/resume: run `4bd07bee-03f3-467f-b5f2-325dd8a61f2f`, independently confirmed at source revision 4. The old repeat job blocked on its earlier revision; latest migration canceled that obsolete job and queued revision 4. The revision-4 repeat succeeded at 00:02:04 UTC, processed the same 10 notices, and preserved totals at 35 opportunities/35 snapshots with zero duplicate source identities.
- Actual Chromium extracted a public 87-page procurement PDF into 143,462 characters, retaining Arabic and technical English, status ready, with original SHA-256 `95249b383c62dd2fe277889fc796120694442e8882e672d0ce4fd756831c0238`; no browser errors. This revealed and verified the PDF worker fix. Public bytes/text remain outside the repository.
- Published anonymous sign-in at 390×844 was visually reviewed with no horizontal overflow. Authenticated mobile is not established by this result.
- Actual cloud snapshot: **437 metadata rows, zero files**. Every row hash passed, and production restore RPCs restored it into isolated local PostgreSQL with 35 opportunities, 35 sources and one knowledge record. Restored sources were paused and access identities were not copied. Private snapshot and temporary harness remain outside the repository. This is not original-inclusive or hosted-target restoration.
- TinyFish run `bf80a51f-1139-47f6-b6a3-b6fa30e1ad1a` could not create/select upload files with its available browser tools. No actual hosted original upload happened. Do not equate local extraction or fixture object transport with hosted Storage acceptance.

## Stage status and remaining acceptance

| Stage | Implemented and verified | Remaining actual acceptance |
| --- | --- | --- |
| 1. Identity/core | Invitation-only email/password, restricted Owner, membership/RLS, revisions, audit/idempotency; actual Owner session and persisted settings. | Hosted multi-role/cross-workspace journeys and authenticated mobile forms. Do not create fake cloud users. |
| 2. Files/review | Private original reservations, byte/signature/hash checks, extraction/packages/addenda, scoped text/files/retries; actual Arabic PDF extraction and verified company note. | Eligible real original prepare → upload → download with exact bytes in hosted Storage. Browser tool lacks file-input capability. |
| 3. Collection/background | Four public collectors deployed, 35 real notices, minute scheduling, immutable snapshots, deduplication fixtures, actual pause/resume. | Hosted repeat/pause/resume/deduplication passed; other portals require their own suitable public feeds/adapters. |
| 4. Free providers | Gemini live inference/usage and background retrieval verified. Automatic Gemini → Qwen → Mistral → Groq round robin enabled; missing config skipped without HTTP. Unknown usage retained without same-input resend. | Actual alternative inference requires genuine free-only account configuration. Simulated outage/quota cases are explicitly local fixtures. |
| 5. Assessment/proposals | Grounded weighted assessment, persistent generation/regeneration, feedback, decimal costing/delivery, evidence-bound approval; full production pipeline integrated against local DB/provider fixtures. | Live notice assessment completed at 00:01 UTC with insufficient evidence (no invented score); eligible confirmed RFP → real proposal → scoped feedback → regenerated version and approved actual costs. No invented prices or approvals. |
| 6. Export/recovery | Editable bilingual draft/final Word, content/hash-bound authorization, separate volumes, manual submission history; 15 fixture export pages visually checked; actual cloud metadata restored locally. | Hosted original-inclusive backup/restore and artifact download; actual Word field/pagination review. No buyer submission/payment. |
| 7. Operations/evaluation | Maintenance/cleanup, real heartbeat/usage/queue, AT01–AT30, increasing RFP fixtures and evaluation CLI. | Real object cleanup, authenticated mobile and Owner-labeled business-quality evaluation. Synthetic scores are not business accuracy. |

## Exact continuation point

1. Implementation changes, package checks, both queue migrations and final publication passed. Final application source `2fb0482fcadcbb7d8242960694f32ee97d9c5331` is on main; successful Pages run `39081884914`. API v15/worker v12 are unchanged. Six public files (HTML/index JS/CSS/source detail/opportunity detail/extraction worker) match the tested build byte-for-byte.
2. Real Ramallah assessment and repeat collection passed SQL and actual Owner browser verification. Newest history shows 10 notices processed, completed, Riyadh timestamps and six-hour enabled scheduling. No further repeat or model probe is needed for this release.
3. All currently runnable acceptance checks are recorded: 314 application tests, 28 isolated Chromium checks, hosted Owner journeys, actual metadata restore, real PDF extraction and hosted transport boundaries. Remaining acceptance depends on genuine business originals/decisions or unavailable hosted mobile/file-input capability; these remain unverified.
4. Full hosted proposal/export acceptance requires an eligible complete RFP plus its actual pricing/capacity decisions. The public 87-page PDF used for extraction contains contact/confidentiality content and was not silently approved/uploaded. The user supplies company details through their public website; prices are determined per tender scope and currency.
5. Existing credentials, content permissions, reservations and uncertainty must be preserved. No external invitation/email, purchase or bid submission is authorized.

## Settled decisions

- Connected-only builds; synthetic users/company claims/business data remain test fixtures only.
- Keep GitHub Pages, Supabase and separate frontend/backend packages.
- Owner supplied the company website; public sourced notes are allowed. No invented certifications, projects or rates.
- Selection → confirmed RFP → full linked proposal → scoped review/questions → regenerated version remains the workflow.
- Gemini Free is confirmed by the Owner. Do not require account login or invented quota-reset facts. Provider quotas/application budgets use persisted automatic retry; unknown generation usage never permits blind resend.
- Automatic optional-provider rotation is authorized independently of individual provider enable switches; real secrets/free-only configuration and exact content authorization remain required.
- Implementation, local tests, publication, hosted acceptance and output quality are different statuses.

## Mapping to the original specification

| Milestone | Current result |
| --- | --- |
| M1 local workspace | Superseded by connected-only production; local simulation is tests only. |
| M2 persistence | Auth/metadata verified in real session; original Storage journey pending. |
| M3 sources/queue | Four active real collectors, durable queue and scheduler; remaining portals manual. |
| M4 analysis/writing | Complete integrated pipeline; Gemini inference verified; actual proposal acceptance pending. |
| M5 export/operations | Export/recovery implemented and tested; actual metadata recovery and scheduler verified. |
| M6 evaluation | Local deterministic and partial hosted evidence recorded separately; no blanket quality acceptance. |

## Acceptance mapping: AT01–AT30

Local implementation and deterministic verification are recorded below. Hosted acceptance and business validation are separate; pending owner inputs are not marked passed. Earlier deployment and investigation checkpoints remain in Git history and the integration report.

| IDs | Implemented behavior | Local evidence | Remaining live acceptance |
| --- | --- | --- | --- |
| AT01–AT04 | Approved-source scheduling, pause/manual blockers, replay deduplication, immutable material-change snapshots and preserved human decisions. | collection.test.ts; collector.test.ts | Four public collectors and scheduled first collections verified; repeat after source revision recovery is being checked. |
| AT05–AT08 | Grounded weighted fit, uncertain/title-only routing, stable declined decisions under reassessment, unresolved ambiguous dates. | model.test.ts; generation.test.ts; operations.test.ts | Owner-labeled held-out data and live model. |
| AT09–AT10 | Exact original eligibility, content authorization, prompt-injection data boundary, no model tools or external business actions. | contentEligibility.test.ts; model.test.ts; modelPolicy.test.ts | Gemini activated; exact public notice/company evidence authorized. Full RFP eligibility remains separate. |
| AT11 | Auth membership/RLS, Owner-only commands, review authorship, private Storage design and historical non-authenticating actors. | database.test.ts; onboarding.test.ts; evidence.test.ts; operations.test.ts | Real signed-in role, object and cross-workspace journeys. |
| AT12–AT16 | Manual acquisition, confirmed RFP gate, extraction blockers, cited inventory, addendum invalidation, exact company-claim evidence and missing-input questions. | commercial.test.ts; evidence.test.ts; generation.test.ts; proposalPackages.test.ts | Representative real RFP and authenticated upload/generation. |
| AT17–AT18 | Server decimal calculations, markup/margin fixtures, zero/unknown rates, tax/period/FX/payment rules and delivery dependencies. | finance.test.ts; commercial.test.ts; proposalPackages.test.ts | Owner-supplied approved rates and assumptions. |
| AT19–AT21 | Version/evidence-bound approvals and export authorization, reviewed artifact hashes, editable bilingual Word and manual submission history. | commercial.test.ts; exportRenderer.test.ts; EXPORT_QA.md | Real Word field update and final artifact attestation; hosted account journey. |
| AT22–AT24 | Free-only ledger, reservation/unknown usage, rate/day caps, leases, cancellation, persisted split/repair checkpoints. | modelPolicy.test.ts; model.test.ts; generation.test.ts | Actual provider quota and hosted worker crash/timeout conditions. |
| AT25–AT27 | Hostname/DNS/redirect/size boundaries, actual hash/signature/parser caps, revisions and atomic audit/idempotency. | collector.test.ts; contentEligibility.test.ts; api.test.ts; evidence.test.ts | Authenticated hosted Storage and commands. |
| AT28 | Superseded demo requirement: connected-only login; no simulated persistence or query bypass. | connected.test.tsx; AuthPanel.test.tsx; app.test.tsx | Published mobile and signed-in persistence. |
| AT29 | Actual heartbeat/storage/queue/usage screen, 10-minute delayed signal and reference-checked cleanup. | operations.test.ts; worker handler tests | Hosted cron heartbeat verified; real original-object cleanup remains untested. |
| AT30 | Original-inclusive bounded backup, complete graph restore into clean matching schema, actor separation and approval reset. | recovery.test.ts; backupFormat.test.ts | 437 actual cloud metadata rows restored into isolated local PostgreSQL. Original-inclusive hosted restore remains untested. |

## Verification commands and maintenance

Run `npm run typecheck`, `npm test`, and `npm run build` in **both** `frontend/` and `backend/`. Each has its own lockfile. Normal checks use synthetic fixtures only and must not invoke real model APIs. The recovery, authorization, financial and evaluation checks are part of the backend suite, not extra counts to add to the total.

Read and update this checklist for every project change. Record implementation, test, source publication, hosted deployment and real-account acceptance separately. Record the exact Pages run after a source deployment completes. Preserve all stages and AT01–AT30 traceability. An unresolved connector operation, unavailable session or missing business input must remain explicit rather than being marked complete.


The real Ramallah notice assessment completed at **00:01:01 UTC / 03:01 Riyadh**, with one settled Gemini request: **798 input / 1,400 output tokens**. It returned needs_review, coverage 0 and no numeric fit score because the available title/company evidence was insufficient. This proves the actual collection → authorized evidence → model → recorded assessment path; it does not establish complete RFP coverage or business model accuracy.

### Browser mobile and collection-history follow-up — verified

Local Chromium with the isolated synthetic fixture exposed horizontal page overflow at 390px: an absolutely positioned screen-reader table label escaped its scroll container, and Knowledge tabs exceeded their flex parent. The table scroll wrapper now establishes a positioning context; tabs are bounded to the available width. All 24 Chromium desktop/mobile route and file/review/export checks passed with no JavaScript errors or external requests; original inputs and persisted Arabic answers were used. The downloaded DOCX is a valid package. These are isolated UI fixture results, not hosted Auth/Storage/model acceptance. This fixture uses no hosted accounts, objects, provider calls or fabricated cloud records.

Final hosted transport checks passed: health 200, anonymous bootstrap 401, missing/invalid worker POST credentials 401, forbidden origin 403. A preliminary GET to the worker correctly returned method-not-allowed 405; the credential tests use its supported POST. Security advisor categories/counts remain unchanged after both queue migrations (3 private-table INFO, 20 deliberate authenticated security-definer WARN, 1 disabled leaked-password-protection WARN).

Actual Owner read-only browser run `0fb194dd-c7b6-4c12-baad-63530b6ea156` confirmed the recorded insufficient-evidence assessment, pre-shortlist processing controls and reload persistence; Ramallah enabled/latest completed collection; verified IIH profile. It exposed missing processed counts in source history and browser-local timezone labels. The connected repository now attaches actual source-run counts (including zero; absent remains unknown), source jobs sort newest first, and dates explicitly use Riyadh. Source-count mapping regression passed for recorded 10, recorded zero, and absent counts. An additional regression prevents a superseded assessment from offering an invalid resume action. All 143 frontend tests/26 files and typecheck/build passed. Published as `2fb0482fcadcbb7d8242960694f32ee97d9c5331` in [Pages 39081884914](https://github.com/salahassi/tenders/actions/runs/39081884914).

Four additional Chromium checks passed for the local Reviewer fixture: review saving, attachment upload, opportunity creation and preference editing remain unavailable. These verify interface gates, with server authorization separately covered by the PostgreSQL/API integration tests. Actual Owner hosted browser run confirmed assessment/progress and profile reload persistence, plus newest successful Ramallah job and enabled source. No authenticated mobile or hosted original-byte upload is claimed.

Final Owner browser run `82e02232-0057-44fa-94f5-74dbf71ac366` saved the user-supplied company name for proposal branding and verified it after reload; other settings were preserved. It verified actual latest source history text “10 notices processed.”, “completed”, explicit Riyadh time and the enabled six-hour interval. Source job timestamps denote creation; SQL completion was 00:02:04 UTC. Final rendered mobile dashboard, knowledge and proposal viewport screenshots were visually inspected. No fixture entry point remains in source.

## October 18 software scope and assessment admission — deployed; acceptance in progress

Owner clarified software, digital transformation, AI and AI transformation services only, excluding hardware, and requires assessment before discoveries enter the inbox. Diagnosis: 34 of 35 notices had blocked `DATA_AUTHORIZATION_REQUIRED` assessment jobs; collection had no service-scope gate.

Implemented an audited Owner discovery policy, exact-public-snapshot authorization limited to selected providers, conservative Arabic/English physical-scope screening plus cited model scope decisions, and an RLS-preserving discovery progress view. The inbox admits current assessed notices only; active assessments, blockers and scope exclusions have separate tabs. Human bid decisions and original records are retained. Policy changes and notice-content changes queue reassessment; authorization-blocked jobs resume only after payload checks pass. Model quota/failover safeguards remain in force. New discovery notifications wait for assessment and exclude scope rejections. Operational discovery permission is not copied in business recovery; reconfigure it on the recovered workspace.

Local verification passed: **191 backend tests / 22 files**, **145 frontend tests / 27 files**, both typechecks/builds, and Deno checks of both Edge entry points. Tests cover exact public provenance, revocation/private-note rejection, Owner/revision/idempotency, RLS membership, restore reset, Arabic/English/mixed scope, real PostgreSQL worker-step completion without inference, stale notice replacement, and truthful UI admission/status.

The full migration hit a connector request-state timeout twice, with readback proving no application. The canonical `20261018075948_software_discovery_and_public_assessment.sql` was then applied in six consecutive hosted records: `20261018082905_software_discovery_policy_snapshot`, `20261018082921_software_public_notice_authorization`, `20261018082932_software_discovery_owner_configuration`, `20261018082941_software_discovery_progress_view`, `20261018082951_software_assessment_requeue`, `20261018083000_software_discovery_notifications_restore`. All six succeeded. Worker **v13** (15 files) and API **v16** (14 files) read back byte-for-byte identical to source; import map `deno.json` is explicit.

Automatic approval review rejected authorization for unconnected Qwen/Mistral/Groq because its accepted egress authorization covered Gemini only. The safe activation configures **Gemini only** for automatic exact-public-notice permission; the existing exact company-profile Gemini authorization remains. At **08:31:41 UTC**, software scope and automatic public assessment were activated via the audited Owner command, and all **35 existing notices** had real queued assessment jobs. All 35 human decisions remained `undecided`. Hosted completion, Pages and browser acceptance follow below; queued is not a completed assessment.

### Hosted scope acceptance and ambiguity follow-up

Initial release `87c24e722e7483bcebcc17d4a671ce5d5bea3850` published successfully in [Pages 39111832368](https://github.com/salahassi/tenders/actions/runs/39111832368); six served entry/review/settings/dashboard assets matched the local build exactly. Owner browser run `28bae1c2-fda5-4a20-bdcb-e45ff6cb6bfa` verified scope settings, Gemini-only automatic permission, queued assessment badges, physical exclusions with quotes, and reload persistence. It could not resize to 390px; no authenticated mobile acceptance is claimed. Its changing default-tab observation is not used as proof of an atomic assessment snapshot.

Actual Gemini assessed a public broadcasting-services notice as uncertain because its title does not establish whether software or operational services are required. Migration `20261018083848_require_confirmed_software_scope_for_inbox.sql` now requires explicit recorded `in_scope` under the software policy; ambiguous/mixed scope stays available under Needs attention. The repository also requires the progress view's exact assessment ID before admitting the item, covering a refresh where progress arrives before its assessment row. Tests assert uncertainty stays outside the inbox, confirmed software enters, and missing/mismatched assessment data cannot appear as assessed. **191 backend and 146 frontend tests**, both typechecks/builds, passed after these changes.

All seven deployed function bodies in the first canonical migration match their local MD5 hashes, and every function has an empty search path. Security advisory counts/categories remain unchanged: 3 private-table INFO, 20 intentional authenticated security-definer WARN, 1 pre-existing leaked-password-protection WARN. No new exposed security-definer view was introduced.

At the follow-up checkpoint, 22 original notices were assessed and 13 queued. Gemini identified the real software-license/information-security notice as in scope; its fit score correctly remains unknown because detailed RFP/company evidence is insufficient. No credential, qualification or probability of winning is inferred from scope eligibility. Final queue and browser checks follow below.


## October 18 notice details and model-only assessment — implementation under verification

The Owner demonstrated known submission/fee/bond facts being reported as missing. The Ramallah adapter had retained listing text only. The Owner subsequently required **no hardcoded assessments**. Keyword scope screening and exact-phrase exclusion shortcuts have been removed; every new scope/fit decision requires model inference and cited evidence. Previous rule results remain historical and are excluded from current admission until reassessed.

Implementation: a leased pre-assessment step reads the approved detail page and bounded public PDF attachments, retains exact collected text and page provenance, and supersedes the listing-only plan. Public page/attachment reads preserve both hostname allowlists, public-DNS/redirect checks, byte/page/text limits and public-only access. Contact blocks are minimized; restricted PDF pages are withheld, image-only/unread/limited pages explicitly recorded. This does not confirm an RFP package or authorize private files. Temporary detail errors persist automatic retry. Successful source polls prompt detail re-reading even when listing text is unchanged.

Published submission clauses are parsed separately from document purchase/opening dates; known local times resolve using the portal timezone, date-only notices retain unknown time. Closed notices leave the current inbox and remain reviewable without modifying human decisions. The model receives the actual evidence coverage and must distinguish known buyer requirements from unknown company proof.

Local evidence so far: Deno parsed the actual 27-page public licensing PDF; 24 eligible pages are available, 3 restricted pages withheld. The HTML includes the actual fee, bond, legal prerequisites and March 10 submission deadline. Technical hardware text is retained in the PDF evidence. Synthetic regressions cover parsing, purchase/submission separation, SSRF/redirect/stream caps, real PDF text/empty/restricted pages, leased persistence, retry, service-only mutation, human decisions and expiry. Full package checks and hosted deployment/browser acceptance are pending below; no hosted completion is claimed at this checkpoint.


Follow-up verification: **189 backend tests/23 files and 147 frontend tests/27 files**, both typechecks/builds and Deno entry checks passed. The new integrated Company Knowledge regression uses an actual local PostgreSQL snapshot containing a verified note plus an extracted company file; both exact-hash references reach classification. The UI names the cited note/file. No such test records were added to the hosted workspace, which currently contains one verified company note and no company files.

Hosted changes: four consecutive detail migrations (snapshot/context, leased completion, retry/refresh, model-only inbox) applied successfully; API v17 and worker v15 are active. Original private minute dispatch resumed after the schema/worker transition. The reviewed Najah document CDN is included in both source and deployment hostname allowlists, with an audit event. A real hosted Ramallah refresh retained 41,707 characters, public-PDF coverage and the 2026-03-10 09:00 UTC / 11:00 Hebron deadline; human decisions were preserved. Source re-evaluation continues; final source publication, readback and browser acceptance are pending at this checkpoint.


Hosted/browser follow-up: Pages source `d31c161ddbcd7e9612b32244626343d1c4e7491f` deployed successfully in run **39114795903**. Owner read-only browser run `d7bf7a40-622e-47c6-8821-e5284623316e` confirmed the Closed tab, actual 350 ILS fee, 20,000 ILS bond, March 10 submission date, 24/27 attachment pages and reload persistence. It observed a superseded plan during background refresh, not a completed fresh model assessment. Its zero Company Knowledge count referred to files; SQL confirms one verified enabled company note and zero files. Do not count this run as completed assessment acceptance.

The hosted run exposed GTD's ASP.NET form container: removing forms discarded the public detail body. The reader now removes controls only and retains the article, with a synthetic regression. Superseded notice-detail plans no longer offer an invalid resume action. Longer full notices exceeded the previous 20k input boundary; classification now allows up to 64k counted input tokens, while all other tasks remain at 20k. The storage/RPC checks match this bound. Existing daily request/input/output budgets, free-only policy, exact authorization, lease checks and unknown-usage protections are unchanged. Queue selection prioritizes unread details before fresh inference; saved remote GET continuations remain first. New DB integration regressions verify larger assessment reservation, rejection above 64k, unchanged 20k for other tasks and pending-detail priority.

Final local code checks for this follow-up: **192 backend tests/23 files, 149 frontend tests/27 files**, both typechecks/builds and Deno checks passed. Hosted API **v18** and worker **v17** include the fixes; three bounded-reservation/queue migrations applied successfully. Detail extraction reached 31/35 notices at this checkpoint; final model results and subsequent publication remain to be recorded.

All **35 notices** now have hydrated detail evidence. Pages `0c80ed96b1ddc30fe4697336e9527aa609c9fab0` completed in [run 39115853410](https://github.com/salahassi/tenders/actions/runs/39115853410); five served entry/review/detail/CSS assets matched the build. A fresh hosted Najah application/security-services assessment completed using exact quotations from the verified Company Knowledge note. It explicitly reports the image-only attachment as unread/OCR-required. This is actual note-to-model citation evidence; company-file coverage is verified by the local database fixture because no company files are uploaded in this workspace.

The subsequent hosted run exposed a settled response truncated at the previous 2,048-token classification output cap. Round-robin masked that measured output error with missing-provider slots, repeatedly retrieving the same completed response. Classification now reserves a bounded 6,144-token output allowance under the unchanged daily budget. After visiting alternatives, measured validation/truncation errors reach the existing single-repair path; an unsplittable classification gets one repair, then an explicit blocker. Unknown usage and in-progress request identity protections remain unchanged. New tests cover GET-only retrieval of the measured truncated result, visiting the missing slot, surfacing the real error and the persisted one-repair limit. Deployment and final checks follow below.

The bounded-output migration and worker v19/API v20 deployed. **194 backend tests** passed after an initial concurrent frontend/backend run exhausted test timing; suites are now executed sequentially. The unchanged frontend exposed a separate test setup race: the save test typed before its fixture workspace finished populating. It now waits for the loaded field value before editing; final full rerun follows.

A superseded Ramallah request was still recorded with unknown usage despite having a durable provider request ID. The new maintenance reconciliation retrieves one canceled/blocked request by **GET only**, verifies the identity and measured usage, and settles its original reservation. It never resends its content or publishes a canceled assessment. A five-minute claim throttle prevents concurrent/repeated polling storms; failed/expired/unmeasured results remain unknown. A service-role-only RPC and an integration regression cover cancellation, failed-GET throttling, exact measured settlement, no additional POST and no result publication.

Final local checks for the recovery changes: **195 backend tests/23 files and 149 frontend tests/27 files** passed, both package typechecks/builds and both Deno entry checks passed. Worker **v20** and API **v20** read back exactly matching all 30 bundled source files. Both bounded-repair and superseded-usage migrations applied successfully. The private minute scheduler remains enabled. Hosted maintenance already reconciled one canceled request from actual provider usage; target assessment/browser and source publication results follow.

Pages `ba2f9c9aaf66f6e29a8a7e35eacf7fcd7ec9d981` published successfully in [run 39116970434](https://github.com/salahassi/tenders/actions/runs/39116970434); CI checks also passed. The actual Ramallah assessment completed from the full notice/PDF and cited the Company Knowledge profile. It identified mixed software/hardware, the 20,000 ILS bond, municipal clearance, profession license, OEM authorization and prior-experience requirements; it no longer asks for the known submission deadline. All three canceled requests with durable IDs were reconciled from actual measured usage; the two older requests without IDs remain unknown.

Owner browser run `4ee2c11e-3d4d-4757-b53b-4e4b6185c454` verified Najah's completed assessment, company capability quotes, unread/OCR attachment warning and an inbox without unassessed entries. It timed out before Ramallah and failed to locate the note section below the file list; it incorrectly treated the workspace name as a knowledge record. SQL and source confirm one note. The Knowledge summary now shows a separate note count and a jump button to the existing note section to make notes discoverable independently of uploaded files.

The real model still assigned low factor ratings from absent company proof. The model instruction now explicitly requires null/unknown for missing or insufficient company proof and affirmative cited mismatch evidence for a low rating; no code assigns replacement ratings or invents a qualification. A follow-up actual assessment is required to verify this instruction; no result is claimed at this checkpoint.

The proof-quality instruction and note-count navigation passed **195 backend / 149 frontend tests**, both typechecks/builds and both Deno checks. API **v21** and worker **v21** are deployed. An audited Owner assessment request for the existing Ramallah notice was queued to verify unknown company prerequisites under the new instruction; human bid decisions and Company Knowledge content were not modified.

Pages `a9cf7a3880cd59fa465b2f58d8edaf7888bbe035` published successfully in [run 39117645057](https://github.com/salahassi/tenders/actions/runs/39117645057); served index/Knowledge/detail/main bundles match the build. Owner browser follow-up `6aa45ef3-ea9d-4e2f-9b1b-6ccade16c408` located the actual verified IIH note and confirmed the exact Company Knowledge source title/quote on Ramallah, 350 ILS fee, 20,000 ILS bond with 120-day validity, separate March 9 purchase/March 10 submission deadlines and persistence after reload. It displayed the prior assessment while the proof-quality follow-up was running; do not treat its old 0/4 prerequisite rating as acceptance of the newer instruction.

The follow-up model response failed citation validation and entered its single bounded repair. Citation comparison now tolerates canonical Unicode and whitespace/line-wrap differences only; it still requires unchanged source characters, source identity, company verification and supplied evidence. Regression checks accept PDF line wrapping but reject changed amounts, reversed wording and blank quotes. This does not prove the specific rejected response was merely whitespace, and no rejected result is being admitted by assumption.

Citation comparison verification passed: **196 backend tests/23 files**, backend typecheck/build and both Deno entry checks. The final frontend code remains the already-tested **149 tests/27 files** from the preceding release. Security advisor categories remain the existing private-table policy notices, intentional authenticated RPC warnings, and password-protection setting; the new reconciliation RPC is not exposed to authenticated clients.

Worker/API **v22** read back byte-identical to all deployed bundle files. Pages run `39118380393` stopped in the unchanged frontend rejection-save test, which has the same fixture-loading race as the success-save test: the initial workspace value arrived after the test cleared the field. Its setup now also waits for the loaded value before typing. This preserves the actual rejection/unsaved-input assertions; the test is not skipped and no timeout was weakened. The temporary queue delays used to prioritize acceptance were restored to their original schedules after the target's bounded repair started.


## October 18: z.ai and owner-selected model identities

User requested z.ai, confirmed both Groq/z.ai accounts are free without paid billing, and clarified that model names must come from secrets. Added the provider adapter, safe environment metadata, contracts, permissions, provider settings, and five-slot round robin. The z.ai endpoint/JSON/thinking parameters were checked against current official docs; pricing lists GLM-4.7-Flash as free, but no model name or ranking is hardcoded. New automatic tasks read the configured model even after it changes; existing remote requests remain identity checked. Groq/z.ai accept Owner-attested provider-managed quotas without invented expiry/balance. Account identity changes, budgets and exact per-provider content consent remain enforced. The schema accepts four-slot workers during rolling deployment. Local/hosted/browser verification follows below; no z.ai live success claimed yet.

The previous Ramallah proof-quality acceptance completed at 10:15 UTC: all four factors are null/unknown with literal Company Knowledge note citations and detailed notice/PDF requirements. Missing company proof no longer becomes an automatic low score. Known bond, fee and deadlines are present; no replacement ratings were applied by code. A read-only settings browser run confirmed round robin enabled but confused billing attestation with key presence; its claim that Groq has no API key is not reliable. Worker metadata remains the source for configuration diagnosis.

The isolated frontend fixture fix `534cedb9a546ddab61f223be846a1aeb75d7b0ce` passed Pages run [39118815958](https://github.com/salahassi/tenders/actions/runs/39118815958). This closes the previous CI failure independently of the new provider work.

Provider changes passed **202 backend tests/23 files and 150 frontend tests/27 files**, both typechecks/builds and both Deno entry checks. Migration `20261018102432_zai_free_provider` applied successfully. API/worker **v23** are ACTIVE; all 30 deployed source files match the bundle byte-for-byte. Health returns 200 and unauthenticated model metadata/worker calls return 401. Live worker metadata confirms Groq has configured model/account/key but lacked free attestation; the Owner-confirmed Groq provider-managed policy is now saved through the audited command. z.ai secrets are currently absent (explicit MODEL_NOT_CONFIGURED); no real z.ai call is claimed.

Automatic review rejected adding Groq/z.ai content consent because it requires explicit authorization to disclose the current Company Knowledge note to these destinations. A precise consent question is pending; the rejected transaction made no consent/discovery changes. The safe standalone Groq billing-policy save succeeded and cannot transmit company content without existing per-provider authorization. Private minute scheduling remains enabled.

The final z.ai adapter omits a forced thinking mode, leaving that optional capability to provider defaults so switching models does not inherit a model-specific toggle. The API model identifier is sent unchanged; unsupported/retired models still produce ordinary provider errors and failover rather than a local name-based rejection.

The Owner explicitly approved public notices and the exact current IIH Company Knowledge note for both Groq and z.ai. Audited discovery/content commands succeeded; readback confirms all three selected destinations (Gemini, Groq, z.ai). Future private files are not included. The final adapter leaves optional thinking to provider defaults. The full backend rerun had one stale test expectation for the removed toggle; corrected assertion verifies the toggle is absent, and all 25 model tests plus typecheck/build/Deno rechecks pass (remaining 177 tests passed in the full run).

Actual Groq connection probe `5b9fe749-bc65-4254-976e-f93db7b34963` succeeded at 10:30 UTC using the Owner-configured model from secrets. The provider returned valid ready JSON and measured 456 input / 12 output tokens; the reservation is settled. No company content was included. Any temporary scheduling changes used for this check were restored immediately. API/worker **v24** read back exactly matching all 30 bundled source files. Security-advisor categories are unchanged. Pages source `3a8398cceb3c64829265e522bbf284ea425670af` is currently running CI; final result/browser follows.

Pages [39119501516](https://github.com/salahassi/tenders/actions/runs/39119501516) passed for `3a8398cceb3c64829265e522bbf284ea425670af`; CI reran both complete suites, TypeScript checks, Deno and frontend build. The served index, entry, runtime and Settings assets match the local build byte-for-byte. Live grant readback confirms internal routing/reservation remain denied to browser roles and available to the service role. Scheduler/round robin are enabled and provider permissions persisted.

Browser acceptance `a1a1295a-3ae2-4ff1-b693-4da271b46c40` verified the new z.ai card, Groq configured identity/free policy, enabled five-provider rotation and reload persistence. Its report incorrectly says all discovery-provider boxes were checked; authoritative SQL confirms only Gemini, Groq and z.ai. It also exposed a real health RPC error after adding a second model profile: a scalar subquery selected multiple model_settings rows. The status function now uses EXISTS across enabled profiles or automatic routing. A database regression covers no providers, two providers, disabled profiles, and routing-only configuration. Deployment/verification follow.

The multi-provider health fix passed **203 backend tests/23 files**, backend typecheck/build. Its hosted migration applied successfully; the same authenticated Owner workspace_status RPC that reproduced the scalar-subquery error now returns health metrics, enabled model state and real usage. API/worker source is unchanged at v24; frontend remains the published build verified by 150 tests.

Hosted health migration version is `20261018103611_provider_pool_status`. Owner browser regression `9f793e02-eb26-4327-b2e1-25ea75b940f4` confirmed the database error is gone, Processing health metrics load, scheduler/model are enabled, and 25 actual calls are shown. Browser state agrees with the authenticated RPC. Security-advisor categories remain unchanged. Groq has a measured successful live connection; z.ai is still unconfigured because its server secrets have not been added. No claim of a live z.ai call or completion of all queued assessments is made.

Final source `df98de995e6d3c13017f9902af05ff1908aa180b` passed [Pages run 39119917337](https://github.com/salahassi/tenders/actions/runs/39119917337), including both complete suites (**203 backend / 150 frontend**), TypeScript, Deno, build and publication. This closes the provider addition and multi-provider status fix; only z.ai credentials/account metadata remain Owner-supplied before a real z.ai request can run.


## October 18: continuing Company Knowledge permission and saved free-account confirmation

The Owner clarified that real comparisons must receive the company expertise and details from Company Knowledge, including subsequently added files/notes, and questioned the FREE_ONLY secret. Added an explicit workspace setting for enabled, verified, current Company Knowledge with selected model providers; exact hashes, revoked-item precedence, Owner authority, tenant scope, source attribution and audit remain enforced. Policy-derived authorizations are distinguished from explicit one-off consent and stop being valid when the policy is disabled. Unsupported/unverified/expired/style evidence is not silently promoted into company proof. No blanket access to other file categories is granted.

Automatic routing now accepts persisted Owner free-account confirmations without model metadata or a FREE_ONLY secret. The existing secret remains an optional backward-compatible attestation; credentials alone still do not establish billing status. Restores clear routing confirmations. Classification now supplies all eligible company source text instead of silently limiting larger profiles to twelve keyword-selected excerpts; actual context/budget limits still apply before generation. Local/hosted/browser checks follow; no new runtime success is claimed at this checkpoint.

Permission-only changes now preserve evidence revisions and completed assessments; changes to company content or discovery scope still invalidate affected evidence/approvals. This avoids resubmitting unchanged evaluations merely because a provider or continuing permission was added. Regression coverage includes Owner-only updates, permission removal, explicit revocation precedence, future company-file/note eligibility, expired/style exclusion, restore resets, full company text after the old excerpt boundary, and saved free confirmation without secrets/profile.

The company-permission migration applied successfully to the hosted database before the Owner clarified that billing attestations should be removed altogether. The final implementation supersedes the temporary saved-free-confirmation UI: credentials select eligible providers, and FREE_ONLY secrets are no longer read. Added persisted provider order, priority/default and optional round robin, revision/Owner validation, automatic waiting/retry after exhausted rounds, and round-attempt counts that exclude background polling. Added integration coverage for ordered failover, provider recovery, missing credentials, invalid orders, and visible attempt/retry state. Existing quota, content authority, usage reconciliation and business-decision protections remain. Full final local suites, deployment and browser acceptance are pending below.

Final local verification passed **212 backend tests / 23 files** and **153 frontend tests / 28 files**, both TypeScript/build checks and Deno API/worker checks. The focused 23-test routing rerun additionally verifies persisted round counts and automatic recovery after provider failures. A new polling assertion will also run in CI. Initial test-fixture/SQL-precedence/TypeScript issues were corrected before deployment.

Hosted `company_knowledge_processing_policy` and `credential_model_routing` migrations applied successfully (the latter hosted version `20261018110020`). API and worker **v26** are ACTIVE, all 30 source files match the submitted bundle exactly, and health returns HTTP 200. The Owner-authorized continuing Company Knowledge policy is saved for Gemini, Groq and z.ai. Evidence revision remains 43 after the permission-only change, avoiding unnecessary reassessments. The internal authorization helper is not executable by browser roles. Routing is enabled in priority mode with the existing Gemini → Qwen → Mistral → Groq → z.ai order, now editable in Settings. Existing application daily limits are unchanged; some real jobs currently wait until their Riyadh midnight reset. No additional live z.ai request or completion of all queued assessments is claimed. Pages CI and browser acceptance follow.

Pages [39121667590](https://github.com/salahassi/tenders/actions/runs/39121667590) passed for `c72fc383ab97b6f46fc4d125c5b68105d6f0d369`, including all **212 backend / 153 frontend** tests, TypeScript, Deno, build and deployment. Security-advisor categories are unchanged. Minute scheduling is still active. Hosted Company Knowledge currently consists of one verified note and zero ready company files; future-file eligibility is covered by integration fixtures, not fabricated hosted uploads.

Browser run `16c27630-0740-44b1-a026-726b270c9414` changed Groq's order, saved and reloaded successfully; the stored routing revision/order corroborates that action. The run exhausted its time before restoring, so an audited Owner command restored the original five-provider order and priority strategy. Its report conflated Cloudflare's separate manual card with the five-item ordered list and reported the company checkbox unchecked despite persisted true policy. A focused read-only browser check follows to verify the live checkbox property and the actual pending-opportunity attempt/time display. No content permissions or application limits changed during the order test.

Focused browser acceptance `80053583-37d3-4391-849c-a94fd45ed5e5` passed: the real pending opportunity displays **Waiting for model quota**, **Attempts: 1**, and **19 Oct 2026, 00:00 Riyadh**. The Company Knowledge checkbox's live DOM `checked` property is **true**. The five-item ordered list is exactly Gemini → Qwen → Mistral → Groq → z.ai, matching authenticated SQL readback (routing revision 3, priority, enabled). No visible page errors occurred. This resolves the first browser report's checkbox/list ambiguity and completes hosted acceptance for attempts, order persistence and ongoing company evidence permission. Current quota waiting is an existing application daily ceiling, not a billing-attestation requirement or evidence of provider availability. The final documentation-only commit does not alter the tested/deployed source.


## October 18: durable model activity, targeted checks and clear waiting status

Implementation in progress: persistent provider attempts with measured versus reserved token counts, validation outcomes, duration, HTTP/request metadata, tenant-scoped opportunity/proposal links and newest-first pagination. Historical usage is labeled without inventing past validation success. Owner probe commands can target one provider without allowing another provider to satisfy the check. Processing health separates queued/running, quota waiting, automatic retries and actual blockers; jobs preserve waiting states. Current hosted 40 blocked is 28 quota-wait +12 blocked (7 input reduction,3 provider request rejection,2 uncertain connections). Local tests, deployment, actual z.ai probe and browser acceptance pending; no new hosted success claimed.


Local validation passed **217 backend tests / 23 files and 155 frontend tests / 29 files**, both TypeScript/build checks and Deno entry checks. Initial SQL argument ambiguity and OpenAPI generator type issues were corrected before deployment; the final HTTP filter/cursor regression also passed. Hosted model_activity_observability migration applied, API/worker **v27** ACTIVE. Targeted z.ai operational probe 61bcf094-b340-4cb5-897d-3754fe7f0e28 queued through the audited Owner command; result pending. Browser roles have read-only tenant-scoped telemetry. Deployment readback, Pages and browser acceptance follow.


Hosted readback confirms all 30 API/worker source files exactly match v27. Health HTTP 200 and security-advisor categories/counts are unchanged. Authenticated status now reports 28 quota waiting, 12 true blocked and 1 automatic retry (z.ai check); the 12 are 7 assessment input-reduction blockers and 5 old model probes. The 28 wait on application daily caps, not billing status. Owner changed routing order independently to Gemini→Groq→z.ai→Qwen→Mistral (revision 4) during this work; that change was preserved.

Real targeted z.ai probe used the supplied **GLM-4.7-Flash** verbatim. Attempts 1/2 returned **HTTP 429 / PROVIDER_QUOTA_WAIT**, durations 1639/1471 ms, provider request IDs captured. Measured input/output/thinking counts were not returned and remain null; conservative reservations are 2489 input / 256 output per attempt. The job automatically retries with increasing delay (round 2 next 11:42 UTC), without using another provider to claim z.ai success. No successful z.ai response is claimed.

Pages [39124052215](https://github.com/salahassi/tenders/actions/runs/39124052215) succeeded for `b112ae6dfd484a1af0c4568367ee37e31b0ae401`, rerunning both complete suites, TypeScript, Deno, build and publication. Published index/entry/runtime/CSS match the local build byte-for-byte. Read-only browser acceptance 9cf58cd3-b410-478e-8c51-a82e38408bb9 is in progress.


Final review identified a queued-probe race: disabling automatic routing could let a targeted check use the legacy manual Gemini path. Added a database guard and regression to preserve the requested provider identity across configuration changes. Full backend rerun and hosted guard migration pending. No UI or edge bundle changes.


The provider-identity guard passed all **218 backend tests / 23 files**, backend TypeScript/build, and its hosted migration applied successfully. Frontend/edge bundles are unchanged from the published build. Browser run 9cf58cd3-b410-478e-8c51-a82e38408bb9 verified real GLM-4.7-Flash attempts 1/2, HTTP 429, unknown measured tokens, round counts, request IDs and durations. It exhausted its execution budget before dashboard/link navigation, and its dropdown report read the first option rather than proving the live select value. A focused read-only follow-up a7f231be-b170-4707-b690-95a022050425 is checking dashboard reasons and live DOM selected value; that ambiguity remains pending. All 23 historical assessment log rows link to their real opportunities by authenticated database joins. No hosted proposal-generation run is claimed in this turn.


Final guard source `e4476290b9123633c78b957f5053ecbf8eac2af4` passed [Pages 39124739323](https://github.com/salahassi/tenders/actions/runs/39124739323), including both complete suites (**218 backend / 155 frontend**), TypeScript, Deno and publication. Hosted SQL confirms the guard is present and browser roles cannot start/finish telemetry. Security-advisor categories/counts remain unchanged. Unauthenticated model-activity and worker requests return 401.


Focused browser run `a7f231be-b170-4707-b690-95a022050425` verified the new dashboard separation and reason labels: at that snapshot 38 queued, 1 running, 0 quota waiting, 1 retry waiting and 5 needing attention (the old connection checks). Business data changed during acceptance, so the original screenshot's 28+12 counts are historical, not fixed expected totals. Minute dispatch responses at 11:52–11:54 UTC are HTTP 200 and process real job IDs; the z.ai check remains queued for retry behind other eligible work. Its next-attempt timestamp is earliest eligibility, not a guarantee of immediate service.

The browser agent again reported an All providers dropdown but omitted the live value; this conflicts with the filtered two-row z.ai data. Added a HashRouter regression asserting actual select.value=zai_free and selectedOptions[0].text=z.ai after loading; all 3 model-activity component tests, TypeScript/build pass. A strictly scoped follow-up `c0cacabd-ef9b-4c75-9cfc-23b212322f03` requests literal JavaScript output or explicit inability to execute, to avoid treating DOM-snapshot interpretation as evidence. No product code was changed based on the ambiguous report.


Final browser diagnostic `c0cacabd-ef9b-4c75-9cfc-23b212322f03` explicitly returned executed=false: TinyFish cannot execute the JavaScript needed to read select.value/selectedOptions. The earlier asserted DOM value is therefore unverified, not a reproduced product defect. The actual HashRouter DOM regression passes. Hosted model activity and health labels were visually verified; live filter DOM introspection and opportunity-link click-through were not completed by the browser tool. These remain verification limits, not claimed E2E passes.

Final local frontend suite passed **156 tests / 29 files**, plus TypeScript/build; backend remains **218 tests / 23 files**. Source `925a9d5ce40613a3713b9d16238f2c7c6086b2b2` passed [Pages 39125262449](https://github.com/salahassi/tenders/actions/runs/39125262449), rerunning both complete suites and publishing the unchanged runtime artifacts. API/worker remain v27 with exact source readback. Final documentation-only reconciliation follows; no additional provider success, completed backlog, resolved historical usage, or complete browser coverage is claimed.


## October 18: provider rejection diagnosis

Implementation: record structured provider error code/type and a normalized reason on each attempt; distinguish z.ai rate limiting, server overload and provider account errors without retaining response bodies, prompts or keys. HTTP 429 alone no longer implies exhausted quota in activity/health/job labels. Existing ordered failover, retry backoff, attempt counts and unknown-usage protections remain. Old logs stay unknown rather than backfilling guessed causes. Local tests, hosted migration/runtime publication and a new independent z.ai operational check are pending.

The first diagnostic release passed 224 backend tests/23 files, both TypeScript/build checks and Deno. All 157 frontend tests/29 files passed in an isolated run: an incomplete new fixture was corrected, and the concurrent run hit the existing UI-journey timing limit; no assertions/timeouts were weakened. The hosted diagnostic migration and API/worker v28 are active; all 30 files match source exactly. Browser roles cannot finish attempts and model_activity remains security_invoker=true; security-advisor categories/counts are unchanged.

A new independent targeted z.ai check on v28 returned no HTTP response before the automatic 20-second timeout (20,214 ms); usage is unknown. It does not explain the historical 429 responses. The older inconclusive check was canceled through an audited Owner command, retaining all attempts/usage. Single-provider operational probes now receive a bounded 90-second timeout, independent of model name; multi-provider work keeps its existing per-provider budget. Final regression/deployment and longer live check pending.

Final local checks passed **225 backend tests/23 files and 157 frontend tests/29 files**, both TypeScript/build checks and Deno. The extra regression receives a valid single-provider result after 21 seconds. API/worker v29 are deployed with the 90-second diagnostic budget. The inconclusive 20-second probe was retired through an audited command without resolving or deleting its unknown usage; a new independent targeted check is queued. Pages publication and actual provider result follow.

The longer-budget v29 check received **HTTP 200** from the supplied GLM model in 4,110 ms, reporting 494 input/256 output tokens. Output hit the diagnostic's 256-token ceiling, so validation correctly recorded MODEL_OUTPUT_TRUNCATED instead of success. This proves an actual z.ai response, but does not establish the cause of older 429s. The provider-neutral connection-probe cap is now 1,024 output tokens to include a modest reasoning allowance; reservation and wire request share this cap. No model name, thinking mode, billing or business-generation limit was changed. Final checks and automatic retry pending.

A subsequent real request returned **HTTP 429 with z.ai code 1305 (overloaded)**, now durably recorded with the request ID and attempt history. This identifies the new rejection as provider-side overload, not proof of consumed account quota or a billing requirement. Historical 429s retain unknown causes. The targeted check remains in automatic retry. The diagnostic UI/source b91fe106134217a43b4fa8e1a1bbd84e5037a4d8 passed Pages [39134595160](https://github.com/salahassi/tenders/actions/runs/39134595160). Final 1,024-token cap passed all 225 backend tests and TypeScript/build/Deno after updating two fixed probe-budget expectations; frontend remains the tested 157-test bundle. API/worker v30 deployed; source readback, next live attempt and focused browser acceptance follow.

Hosted v30 readback matches all 30 source files exactly. The new diagnostic recorded two actual 429/1305 overload responses with request IDs and retry rounds; output counts remain unknown when the provider does not report them. Next scheduled attempt retains normal backoff. Focused real-browser run `85e95c6a-ae25-40ed-8c34-c396eb87ed08` verified the historical-429 explanation, expandable Provider error code/type fields as Not recorded, HTTP status, request ID and round number, with unknown tokens preserved. This was read-only; its report's canceled label refers to the old job, not a successful attempt. The published index, Jobs and OperationsPanel assets match the tested frontend byte-for-byte. New known-reason rendering is covered by component/integration tests and the hosted row; no additional live browser check of that newer row is claimed.

Final source `a64bb25092e9a12613ed365a04eb2e1e1e84a097` passed [Pages 39135032795](https://github.com/salahassi/tenders/actions/runs/39135032795), including both full suites (225 backend/157 frontend), TypeScript, Deno, build and publication. Runtime remains v30 with exact source readback. The operational result is a confirmed current z.ai overload (1305), with automatic retry and durable attempts; successful completion under the larger probe cap is not yet claimed. The change does not alter provider order, credentials, application daily ceilings, company evidence policy, or historical unknown usage. This final reconciliation is documentation only.

## October 18: OpenAI and Claude support

Implemented native OpenAI Responses and Anthropic Messages adapters, owner-supplied model names, structured request/error metadata and measured token usage (including Claude cache-read/cache-creation input). Added OpenAI/Claude to credentials, provider policies, ordered failover, targeted probes, company/discovery permission controls and activity filters. Existing provider order is preserved with the new providers appended; older five-provider clients/workers remain compatible during rollout. No model names, account billing attestations or keys are fabricated. Missing credentials skip without network calls.

Local validation passed **235 backend tests / 23 files and 159 frontend tests / 29 files**, both TypeScript/build checks and Deno API/worker checks. Integration coverage exercises each native adapter, OpenAI 429 → Claude success, missing credentials, measured cache/reasoning usage, incomplete output and request metadata. These use fixtures; no real OpenAI/Claude inference is claimed.

Canonical migration `20261018142401_openai_claude_providers.sql` applied as hosted `20261018144138`. API/worker **v31** are ACTIVE and all 30 files match submitted source exactly. Health returns HTTP 200; anonymous model activity returns 401. The private routing implementation remains inaccessible to browser/service roles (the existing service wrapper remains the entrypoint). Security-advisor categories/counts are unchanged. Hosted priority order preserves Gemini → Groq → z.ai → Qwen → Mistral and appends OpenAI → Claude, routing revision 5.

Automatic approval review rejected adding OpenAI/Claude to the current Company Knowledge sharing policy because prior explicit destination consent named Groq/z.ai. No workaround was attempted: the hosted policy remains unchanged at workspace revision 7 / evidence revision 45. The new sharing controls are implemented and tested; enabling this workspace policy awaits explicit Owner approval. UI publication and real-browser setup inspection follow.

Source `9356d48a8bae192762040799894ca6c879b9f84b` passed [Pages 39137277869](https://github.com/salahassi/tenders/actions/runs/39137277869), including both complete suites, TypeScript, Deno, build and publication. Published index and Settings bundle match the local build byte-for-byte. Anonymous worker POST returns 401; minute scheduling remains active. The service routing wrapper is executable by service_role and not authenticated, while its internal implementation remains private.

Read-only browser run `2fde88fd-1a66-41f6-81a2-51485b0eb5bc` reported both new provider cards and targeted-check buttons visible in the authenticated Settings page. Its provider-order report conflated card order with saved routing order and some older provider metadata appeared shifted; those details are not accepted as proof. Hosted readback confirms the preserved priority order at revision 5. The new cards were reported unconfigured, but no independent server-secret metadata read or actual OpenAI/Claude request was performed. Provider inference and full live configuration E2E remain unverified pending credentials and explicit sharing-policy approval; native adapter/failover behavior is covered by integration fixtures. No hosted business data or company policy changed during browser verification. Final reconciliation is documentation only.

The Owner subsequently approved OpenAI/Claude data processing and confirmed no API keys are available. The audited `discovery.configure` command now includes both providers for public notices and eligible current/future Company Knowledge. Hosted verification confirms workspace revision 8, unchanged evidence revision 45, one policy audit event, enabled automatic routing and unchanged order/revision 5. The earlier approval block is resolved. A focused local rerun passed **12 adapter/routing tests across 2 files**, including skipping missing configuration without external requests, targeted-provider identity and OpenAI-to-Claude failover. These are fixture-based integration checks, not authenticated provider inference. No new external model call, runtime change or deployment was needed; actual OpenAI/Claude results remain unverified until API keys and supplied model names are configured.

## October 18: settings organization and provider configuration review

Reviewed Settings against its commands, environment parsing, routing SQL, content policy, maintenance and source scheduling. Confirmed confusing duplicate model identity inputs, an ineffective individual enabled toggle during automatic routing, conflicting static failover ranks, repeated per-item/provider buttons, and stale free-only/retention copy. The displayed workspace polling interval is a default for newly added sources, not a reschedule command for existing sources. Browser audit `2a6008f6-3574-4cf7-96d5-a47e1c34a355` corroborated page density; its claim of two order-save buttons conflicts with source and is not accepted as fact.

Implementation in progress: six navigable sections that load on first visit and retain drafts; one ordered automatic-provider card per provider with read-only server identity, credential presence and a targeted probe; separate data-sharing policy, compact searchable individual content review, and usage reconciliation under operations. Legacy manual routing and advanced ceilings remain explicitly labeled. Individual permission-record absence no longer claims content is forbidden when a workspace policy may apply. Save-one-provider preserves other drafts. No secrets, hosted provider order, consent, quotas, schema, evaluation logic or worker behavior are being changed. Local tests and published/browser verification pending.

Local verification passed **165 frontend tests / 31 files and 235 backend tests / 23 files**, both TypeScript/build checks. The first concurrent full run timed out in an existing unrelated navigation journey; the complete isolated rerun passed without weakening assertions or timeouts. Focused new coverage checks provider-specific probes, missing keys, server-identity review, order/strategy persistence, failed-save preservation, independent drafts, role gates, exact-hash permissions and measured zero usage. Local Chromium acceptance passed **14 checks** at desktop (1440px) and mobile (390px): all six sections fit without horizontal overflow, a single order-save action and seven automatic cards, disabled unconfigured probes, order/strategy save and reload, and an Arabic draft retained across sections. These use isolated synthetic fixtures with zero external requests. Temporary browser files were removed from production source. Hosted readback preserves workspace revision 8 / evidence 45 / routing revision 5 and existing company policy. Publication and authenticated browser acceptance pending.

Source `98d6fa34ab13f1f70cae1d94950b089b8c1cf160` passed [Pages 39146970629](https://github.com/salahassi/tenders/actions/runs/39146970629), rerunning all **400 tests**, TypeScript, Deno, build and deployment. Published index, Settings script and admin stylesheet match the local build byte-for-byte. API/worker remain the previously verified **v31**; this release changes the frontend only.

Authenticated browser run `09be773a-c75c-4ec5-a2a6-2bd443e27c07` confirmed six-section navigation and the assessment/data heading, but sampled the initial model-loading state and did not finish operations navigation. Focused follow-up `400b9f88-f193-471f-9af5-ba1c8ffbea62` waited and confirmed model settings load successfully with no visible errors, automatic priority routing and read-only model information. It distinguished items below the viewport from missing DOM elements; full live scrolling/count and operations acceptance are not claimed. The complete layout/save/reload journeys are covered by the local Chromium checks above. No live provider probe or hosted settings mutation was performed. Final reconciliation is documentation only.


## October 18: Cloudflare in automatic routing

The Owner identified Cloudflare's exclusion from the automatic provider list. Implementation includes it in priority/round robin, saved order, targeted probes, per-attempt telemetry and credential-based selection. The migration appends Cloudflare while preserving the existing strategy and relative order, and accepts older four/five/seven-slot workers and five/seven-provider clients during publication. The separate legacy-only card is removed; incomplete credentials skip without network calls. Existing account identity, content permissions, application budgets and unknown-usage protections remain. Local checks, hosted migration/runtime publication and browser verification are pending; no real Cloudflare inference is claimed.

Local verification passed **239 backend tests / 23 files and 166 frontend tests / 31 files**, both package TypeScript/build checks and Deno API/worker checks. The concurrent suite run timed out in the existing frontend navigation journey and caused two follow-on failures; the complete isolated frontend rerun passed without changing assertions or timeouts. Cloudflare coverage includes native endpoint/account/model identity, a targeted successful probe with measured usage, HTTP 429 failover, missing account skips, eight-provider rotation and seven-slot worker compatibility. Local Chromium passed **15 checks** across desktop/mobile, including eight cards, Cloudflare reordering/save/reload and the provider-specific probe action. All browser data was synthetic and local, with zero external requests; the temporary entry was removed.

Hosted deployment is **blocked, not complete**. Two Supabase `apply_migration` calls returned `McpServerError: Invalid or expired requestState`. Read-only verification after both confirms zero migration history entries and the unchanged seven-provider round-robin order at revision 6. The CLI alternative reports `AccessTokenRequiredError`; no credentials were read or fabricated. API/worker and production Pages were not changed. Source is prepared for a draft branch/PR; do not publish the frontend or eight-slot worker until the database migration succeeds. Deploy API, worker and frontend afterwards, then verify source readback and hosted behavior. No real Cloudflare inference or hosted browser acceptance is claimed.


The follow-up resolved publication by replacing the repeated full-function migration text with an atomic, guarded migration. It checks the exact existing function-body SHA-256 values, changes only routing/probe provider lists and bounds, and verifies that the resulting bodies exactly match the previously tested definitions. The complete **239-test backend suite**, TypeScript and build passed again; frontend code and its **166 tests / 15 local Chromium checks** are unchanged. The shorter request succeeded; the earlier error's internal cause is not independently established. No plugin permission changes or new credentials were needed.

Canonical `20261018172905_cloudflare_automatic_routing.sql` applied as hosted `20261018180805`. API and worker **v32** are ACTIVE. Hosted routing is enabled, round robin, revision 7, with Gemini → Groq → z.ai → Qwen → Mistral → OpenAI → Claude → Cloudflare. Current content-sharing policy is unchanged. The private helper remains inaccessible to browser roles, and the service wrapper remains callable by service_role. Source readback, Pages publication and final acceptance follow.


Cloudflare release source `f93b50b30c7de96a062395b573884535a35db85f` passed [Pages 39152956954](https://github.com/salahassi/tenders/actions/runs/39152956954), including all **405 tests**, TypeScript, Deno, build and deployment. Published index, Settings script and admin stylesheet match the local build byte-for-byte. API/worker **v32** readback matches all 30 submitted files exactly; health returns HTTP 200 and anonymous model activity returns 401. Security-advisor categories/counts remain unchanged.

Read-only authenticated browser run `e88df3c8-b720-4f62-b9ed-1d15b1f4e9d5` completed and reported the eight-provider saved order, Cloudflare at position 8, its targeted-check button present, and absence of the old Legacy manual fallback section. Cloudflare is currently reported **Not configured**. The report did not independently establish the button's live disabled property, so that detail remains covered by local UI tests rather than claimed hosted DOM verification. No settings were changed by the browser, no live Cloudflare inference was performed, and data-sharing permissions are unchanged. The Supabase publication blocker is resolved; final reconciliation is documentation only.


## October 18: configurable company service scope

Implementation in progress: replace the embedded business-sector preset with Company Knowledge, owner keywords, or both. Interest/exclusion terms are editable configuration; the model interprets procurement context and cites the chosen scope basis. Keywords cannot prove company expertise. Verified company files/notes remain the sole source of capability evidence. Scope/keyword changes invalidate dependent assessments and approvals and queue reassessment; sharing-only changes preserve evidence revisions. Restore resets automatic sharing. No provider order or destination permissions change. Local tests, runtime/database publication, Pages and browser verification pending.

The backend implementation passed **245 tests / 24 files**, TypeScript/build and Deno API/worker checks. Coverage includes Arabic/custom non-technology scope, Company Knowledge quotation validation, configured keyword citations, unknown capability without company evidence, keyword-change revision/reassessment, role/revision/idempotency boundaries and unchanged consent behavior. Frontend full tests, local browser acceptance and publication remain pending.

Frontend TypeScript/build and **169 tests / 31 files** passed. The unrestricted local test run hit several existing 5-second UI timing limits; the complete rerun with two workers passed without changing assertions or timeouts. Local Chromium passed **9 checks**: all three scope modes at desktop/mobile widths, Arabic/English normalization, empty/conflicting-keyword validation, save/reload and draft preservation across sections. These used isolated synthetic fixtures and made zero external requests; the temporary entry was removed. An additional adapter test confirms invalid scope citations record a failed attempt with measured usage and fail over to the next provider. Final backend regression and publication pending.

Final backend regression passed **246 tests / 24 files**, TypeScript/build and Deno. Supabase applied the schema migration, then rejected the full command-definition request with `Invalid or expired requestState`; readback confirmed it had not changed the function. Replaced that migration with a 1,996-byte atomic update guarded by exact before/after function-body hashes, producing the identical tested definition. The focused 12-test discovery integration suite passed against all migrations, and the compact request succeeded. No permission/credential changes were needed.

All three scope migrations are applied. API/worker **v33** are ACTIVE and all **31 files** match submitted source exactly. The hosted command hash matches the tested definition, and opportunity_discovery retains security_invoker=true. The audited Owner command selected combined scope using the Owner's previously stated interests and exclusion; these are stored workspace configuration, not repository business constants. Workspace revision 10 / evidence revision 54; automatic notice/company sharing destinations and provider routing are unchanged. Reassessment has been requested; Pages publication and hosted queue/asset acceptance follow.

Source `7ffed4e3bb8f11a02e1ee21ac67359991b0f50a8` passed [Pages 39169516745](https://github.com/salahassi/tenders/actions/runs/39169516745), including all **415 tests**, TypeScript, Deno, build and publication. The published index, Settings/Review bundles and admin stylesheet match the tested build byte-for-byte. Health returns 200; anonymous model activity and worker POST return 401. Hosted migration versions are `20261018211845`, `20261018214725` and `20261018214740`. The earlier Supabase request-state blocker is resolved.

Hosted readback confirms one audited combined-scope update and 38 new assessment plans carrying the exact saved scope snapshot at evidence revision 54. At verification, 37 jobs were queued and one was in `MODEL_DAILY_QUOTA_WAIT`, next retry `2026-10-19T21:00:00Z`; no newly completed live assessment is claimed. Existing application/provider daily ceilings were preserved. Real model completion waits for available budget. Browser save/reload coverage is the local Chromium acceptance described above; no new authenticated hosted browser session is claimed. This final reconciliation is documentation only.


## October 19 (Riyadh): stalled discoveries and rejected-request reservations

Diagnosis: 38 collected opportunities, all waiting on the configured daily output budget; 24 are closed and 14 remain open. Four automatic sources last polled successfully on their six-hour schedule; the other 31 directory entries require collectors and are not active feeds. The budget sums kept full reservations for proven HTTP 429 generation rejections even though their ledger state was settled. This contributed to a daily stop despite much smaller reported usage.

Implementation: release only the internal token reservation when durable telemetry proves an initial generation HTTP 429, with matching usage/workspace/job/provider and no accepted remote request. Measured values remain unchanged (including null), calls still count, and missing telemetry, unknown usage, poll failures and accepted Gemini requests retain reservations. Admission limits and health totals use the same accounting; affected daily-wait jobs are eligible for a budget recheck. No source activation, content permission, provider order, hard ceiling or evidence changes. Tests and hosted verification pending.

Local validation passed **248 backend tests / 24 files and 169 frontend tests / 31 files**, both TypeScript/build checks. Tests prove failover under a one-request output budget after a confirmed initial 429, retain null measured values, and preserve reservations for missing telemetry, HTTP 503, retrieval/poll errors, accepted remote requests and unknown states. The existing per-workspace call ceiling and provider content authorization checks still apply.

The accounting migration is deployed. Hosted output-budget accounting changed from 47,353 to 33,017 by releasing four confirmed initial-rejection reservations; reported output remains 2,297 and both unknown-state records are unchanged. Fourteen non-expired assessment jobs were made eligible to recheck their budgets immediately; expired work keeps its existing schedule. The security advisor retains the same three finding categories. API/worker remain v33; no Edge code or frontend code changed. A fresh audited collection round was queued on the four already approved automatic sources; actual completion and any newly collected notices are tracked separately. Source publication and final hosted observations pending.

Source `fecac65139f55136006dc80df3ec1296ef9023bc` passed [Pages 39173073672](https://github.com/salahassi/tenders/actions/runs/39173073672), including all **417 tests**, TypeScript, Deno, build and publication. Canonical migration `20261018223214_rejected_request_reservation_accounting.sql` is applied as hosted `20261018223646`. Authenticated health readback uses the corrected accounting. Existing unknown usage remains unresolved; this correction does not convert unreported usage into measured zeroes. Browser behavior is unchanged and no new hosted browser E2E is claimed.

Final hosted observation at **2026-10-19 01:45 Riyadh**: all four audited collection jobs succeeded (Jordan processed 7 notices, Najah 19, IsDB 0, Ramallah 10); no new opportunity was inserted and the total remains 38. Processed counts include existing notices and are not discovery-growth counts. Twenty-four opportunities are expired and fourteen remain open. All fourteen open assessment jobs are eligible now: eleven queued and three retaining the daily-wait label until the worker rechecks them. Source polling refreshes notice-detail evidence first; no new model request or completed current assessment is claimed at this observation. Minute scheduling remains active. Additional bounded dispatcher invocations used the existing worker, lease and budget checks without changing cron frequency. The 31 manual/proposed directory entries remain unconnected; expanding collector coverage is separate remaining work. Final reconciliation is documentation only.

## October 19: autonomous processing and notification preferences

The Owner requires unattended collection, immediate assessment scheduling, provider failover, retry recovery and email alerts/digests with preferences. Automatic routing no longer uses internal daily call/token admission ceilings, remote token-count requests, stored account-identity approval or the legacy plan-call cap. Actual reported usage remains logged, including unknown values. Manual policies, content authorization, evidence validation and active remote-request protections remain. Unknown duplicate requests have a bounded 15-minute cooldown, extended by recorded remote deadlines.

Transient failed rounds and collection failures retry after 1, 2 and 4 minutes, then hourly; finite provider retry times are respected. Failure counts are separate from worker polling attempts. A persistent failure generates one deduplicated alert after four failures; irrecoverable configuration/evidence blockers alert immediately. Source completion schedules assessment refresh immediately. SMTP failures cannot prevent the worker from claiming processing jobs.

Per-user Notifications preferences support failure alerts and review digests every 6/12/24/48/168 hours, in Arabic or English. Digests count current eligible discoveries and proposals; empty queues do not send. Generic SMTP uses server Secrets, verified current account recipients, TLS/STARTTLS, a durable outbox, current membership/preferences checks and bounded delivery retries. Accepted SMTP delivery is distinct from inbox receipt; uncertain acceptance is recorded without silent resending. Secrets and attachments do not enter emails or diagnostics. Restore pauses notification delivery. Eligible terminal outbox records follow workspace retention; unconfirmed records remain.

Local verification passed **262 backend tests / 25 files and 174 frontend tests / 32 files**, TypeScript/build checks and Deno entry checks. Local Chromium passed **8 checks** at 1440px and 390px: saved opt-in gating, preference save/reload, draft retention, test-queue feedback, no automatic token-ceiling controls and responsive layouts. These used isolated synthetic fixtures with zero external requests; the temporary entry was removed. The final SMTP sender-format diagnostic follow-up passed the complete backend regression; no authenticated hosted browser acceptance is claimed.

The automation migration applied as `20261019092629`. Two requests for the combined notification migration returned `Invalid or expired requestState`; readbacks confirmed no objects/history were created. Splitting the exact unchanged SQL into schema, commands and delivery-worker transactions resolved the tool failure. Hosted versions are `20261019100822`, `20261019100842` and `20261019100913`; the split-migration notification integration suite passed all 13 tests. API/worker v38 are ACTIVE. The 33 reachable files returned by deployment match submitted source; the bundler omits unused shared files. RLS and worker-only RPC privileges were verified. Advisor categories remain the same: three private no-policy tables, 22 authenticated security-definer findings (including authorized user RPCs), and leaked-password protection.

The audited Owner preference command enabled Arabic failure alerts and daily review reminders at revision 1. SMTP diagnosis identifies only APP_SMTP_FROM as invalid. The Owner confirmed its value was the display name TenderDesk without an email address. Standard display-name-plus-address syntax is supported; the Owner was asked to supply a verified sender address in Secrets. No successful mail delivery is claimed yet. Hosted model logs demonstrate actual Gemini/Groq/z.ai attempts and failover followed by retry_wait with failure_count; provider quota/network errors still occur. Historical failed manual probes remain historical. The four approved automatic collectors continue on their schedule; 31 manual/proposed directory entries are not newly connected by this release. Pages publication, final sender-format runtime readback and actual SMTP test remain pending.

Source `151b8ce4a45d36598dd727c8d66c8e781d3a2c88` passed [Pages 39236344268](https://github.com/salahassi/tenders/actions/runs/39236344268), including all 436 tests, TypeScript, Deno, build and publication. Published index, Settings bundle and admin stylesheet match the local build byte-for-byte. Health returns 200; anonymous notification settings and worker requests return 401. Two actual assessment jobs succeeded via Groq after the automation migration, including one with a previous failed round; remaining provider-side quota/network errors continue through the retry policy.

The worker now reports SMTP configuration ready after the sender setting changed, but the first actual Owner test was rejected by the SMTP server (SMTP_REJECTED); it is not recorded as delivered. A follow-up adds predefined sender-domain/test-recipient rejection codes and safe SMTP response-code/command diagnostics without raw server responses, addresses or credentials. API/worker v40 are ACTIVE; a new test will distinguish the account/sender restriction. No successful SMTP acceptance or inbox receipt is claimed at this checkpoint.

The SMTP diagnostic follow-up passed **263 backend tests / 25 files**, including 14 notification integration tests, plus TypeScript/build and Deno checks. Frontend remains at **174 passing tests / 32 files** with unchanged published assets. Final source/runtime reconciliation and the second real SMTP test are pending.

Final release `1dd129f2d65d799473b9599d02b1fa68a603e014` passed [Pages 39236879731](https://github.com/salahassi/tenders/actions/runs/39236879731), including all **437 tests**, TypeScript, Deno, build and deployment. API/worker **v40** readback matches all **33 reachable files** exactly. The frontend is unchanged from the byte-verified published assets above. Code, migrations and publication are complete; no authenticated hosted browser session is claimed (the available browser profiles have no recorded signed-in sites).

The second real Owner email test reached SMTP and was explicitly rejected with **SMTP_SENDER_DOMAIN_UNVERIFIED**. No email was accepted or claimed delivered. The remaining external setup is verifying the sender domain in Resend using its required DNS records, then retrying the test. User preferences remain enabled: failure alerts and daily Arabic review reminders. Actual hosted processing has completed two assessments via Groq; queued work and temporary provider failures remain under automatic scheduling/retry. Four approved collectors remain automatic; the 31 unconnected directory entries remain separate scope. Final documentation reconciliation only; no secret values or customer content are committed.


## October 19: successful Resend SMTP sandbox test

The Owner selected testing only, confirmed that the TenderDesk and Resend account email addresses match, and saved the Resend sandbox sender in Supabase Secrets. One new idempotent `notification.test` command was queued for the verified Owner account and processed through the existing dispatcher, durable outbox and generic SMTP worker. Delivery `4f78ae43-fe65-4aa2-9591-ea8f1773764c` reached **sent** in **one attempt**, with no error and a recorded message identifier, at **2026-10-19 13:30:49 Riyadh** (`10:30:49Z`). This proves real SMTP acceptance by Resend; the Owner subsequently confirmed actual inbox receipt ("وصل").

No application code, schema, recipient, preference, provider-routing or cron change was needed. No duplicate test was submitted. The Resend sandbox permits delivery only to the account-associated email; arbitrary production recipients still require a verified sender domain. This documentation-only follow-up preserves the prior 437-test release evidence; no unchanged code tests were rerun.


## October 19: seeded, database-owned source extraction

Source configuration stage: implementation and backend deployment complete; frontend publication and live collection verification pending. Audited all 35 hosted sources: all are seed-backed (35 source.catalog.seed events). Removed four institution-specific runtime registries/branches and fixed frontend institutional/country choices. Seed profiles now contain source URL, buyer, timezone, listing/detail selectors, labels and description templates. Workers load profiles from source database rows; new sources using supported layouts need configuration rather than a named code branch. API validates the declarative profile and collection URL. Collection permissions and generic safety limits remain enforced.

Explicit administrative seed backfill applied to four unchanged approved collectors; replay yielded exactly four extraction seed audit events, no duplicates. Readback confirms only extraction plus revision changed: Najah/GTD/IsDB 3→4, Ramallah 5→6. All 35 identities, URLs, approval states, permitted hosts and schedules are preserved. The other 31 manual/proposed entries remain unconnected. No schema change, permission grant or new source activation occurred.

Local backend: **266 tests / 25 files** passed, TypeScript/build and Deno API/worker checks passed. Added configuration-driven unknown-site listing/detail tests and database backfill/replay tests including owner-edited profile and URL preservation. Local Chromium at 1440px/390px passed profile edit/save/reload, database-derived new-country filtering and generic adapter selection with no page errors or external requests. This was an isolated synthetic browser fixture removed before the production build; no authenticated hosted browser acceptance is claimed. Frontend **174 tests / 32 files**, TypeScript and production build passed.

API and worker **v42 ACTIVE**, readback matches all **33 reachable files** exactly. Three actual approved source collections were administratively queued with explicit verification audit events; the fourth already had a current-revision scheduled job and was not duplicated. Results pending. No secrets or private company content were read or committed. Release source/workflow reconciliation pending.


Release `a5d0c5f7bb9d33e2c75e186a74e46084aeb05e2b` passed [Pages 39240778218](https://github.com/salahassi/tenders/actions/runs/39240778218): all **440 tests**, TypeScript, Deno, production build and publication. Published index, Sources and SourceDetail bundles match the local build byte-for-byte. API health returns 200; anonymous sources and worker access return 401. Code, seed backfill, runtime and frontend deployment are complete.

Fetched the four real public listing pages (HTTP 200) and ran the production parser locally using extraction profiles read back from hosted database rows: Najah **19**, Ramallah **10**, GTD **7**, IsDB **0** currently open records (closed notices skipped). These are parsed listing counts, not newly ingested discoveries. The cloud workspace's direct Node collector could not validate proxied DNS destinations; validation used bounded proxy HTTP retrieval followed by the unchanged production parser, without weakening production SSRF checks. Hosted scheduled verification jobs remain queued behind existing assessment work at this checkpoint; no successful post-deployment hosted collection completion or authenticated hosted browser E2E is claimed. Their durable queue and normal retry/scheduling policy remain intact. Documentation reconciliation only; no additional application changes.


## October 19: explain source activation prerequisites

Investigated the Owner's missing activation actions. Hosted data confirms four approved website collectors and 31 proposed/manual entries with adapter_required=true and no extraction profile: 15 public listings, nine supplier-registration portals, four central redirects and three procurement platforms. Frontend canCollectSource hides Enable for these rows; SQL independently rejects source.action approve with ADAPTER_REQUIRED. The five-enabled-source trial cap remains in frontend and SQL, but is not causing the current four-enabled/31-unconfigured state. No role, source, permission, scheduler or database configuration was changed.

UI now shows Setup required, a reason based on stored catalog metadata, and an actionable Set up collection link (View requirements for non-Owners). Details explain the missing integration and the save-paused-then-enable sequence. Manual sources without an extraction profile must explicitly select a collection method instead of silently defaulting to RSS. Supplier registration is explicitly distinguished from an available tender listing. This fixes the misleading blank Actions column; it does not claim to implement the 31 missing integrations.

Expanded the existing HTTP/SQL/worker integration flow to start with a manual source: premature enable is denied, valid feed configuration persists paused, enabling succeeds at the new revision, the worker collects, and repeated collection deduplicates. All **266 backend tests / 25 files**, TypeScript and build passed. Frontend **175 tests / 32 files**, TypeScript and build passed. Local Chromium passed five checks at 1440px and 390px: actionable list-to-setup navigation, explicit method validation, responsive setup layouts and configure/reload/enable/persist. This used an isolated synthetic fixture with no external requests and was removed before the production build. Hosted authenticated browser acceptance is not claimed. Publication pending. Runtime and database schema are unchanged from v42.


Published source `f8313c9d3cd27b2b209a56852b693692853bcb06` passed [Pages 39244372467](https://github.com/salahassi/tenders/actions/runs/39244372467), including all **441 tests**, TypeScript, Deno and build. Published index, Sources, SourceDetail and admin CSS assets match local output byte-for-byte. Hosted function readback confirms both the adapter guard and five-enabled-source limit remain in collection_command. The missing-setup UI and explicit method choice are deployed; the 31 unconnected sources still require real integrations, and no hosted source was activated by this release. No hosted authenticated browser session is claimed. Documentation-only reconciliation follows this release.


## October 19: remove the five-enabled-source limit

The Owner explicitly authorized removal. Both frontend activation paths now submit normal source.action commands without counting enabled sources. Migration 20261019113019_remove_enabled_source_limit replaces only the enabled-count guards in app_private.collection_command and app_private.evidence_command, retaining authorization, adapter/access requirements, revisions, auditing and idempotency. It does not modify source rows, scheduling policy, permissions or unrelated capacity controls.

Local verification passed **267 backend tests / 25 files** and **177 frontend tests / 32 files**, both TypeScript checks and production builds. A PostgreSQL integration test enables seven sources, pauses/resumes one while six remain enabled, confirms all seven schedule, and confirms stale revisions, unconnected sources and missing access configuration are still rejected. Connected UI tests cover the sixth source from both list and detail views. Local Chromium independently passed directory resume, detail pause/resume and persistence across reload with six active synthetic sources, zero external requests and no page errors; the isolated fixture was removed before building. No synthetic source was created on the hosted workspace.

Hosted migration **20261019114305** applied successfully. Readback confirms both count guards removed and security-definer settings, empty search_path and postgres-only ACLs unchanged. Restoring the removed guard in a read-only hash expression exactly reproduces both pre-migration body hashes, proving no other hosted function change. Local evidence_command matches the hosted body; collection_command differs only by a pre-existing unused operation_key declaration in local migration history. Security advisor categories/counts remain unchanged (3 private no-policy tables, 22 authenticated security-definer RPC findings, leaked-password protection). The 35 real sources retain their activation revisions and states (four approved); frontend publication and release reconciliation pending. API/worker code remains v42; no Edge Function redeployment is needed for this SQL/UI change.


Release `19a91b6f22e8296120b0f5974f0dedda2e9b6759` passed [Pages 39246966583](https://github.com/salahassi/tenders/actions/runs/39246966583), including all **444 tests**, TypeScript, Deno, build and publication. Published index, Sources and SourceDetail bundles match the tested local build byte-for-byte. Hosted source activation hash remains `9cccb78cb53eaf8a2c08f7b437fb4d50` before/after migration (35 records, four approved), confirming no source activation/revision changes. Database migration and frontend rollout are complete; additional prepared sources can be enabled or resumed without the retired five-source ceiling. Documentation-only reconciliation; runtime v42 and existing connections remain in place.

## October 19: collect notices and discover source links together

Collection stage: combined mode implemented with a database-owned adapter_config.discover_source_links flag alongside the existing validated extraction profile. One page fetch returns both notices and source candidates through the existing transactional completion function. Configured listing rows, including filtered/superseded notices, cannot become candidate sources. Combined discovery also excludes navigation, attachments, self-links and duplicates. Candidates remain manual/proposed with adapter_required=true, no approved hosts and no schedule; discovery does not fetch or enable them. A broken notice schema fails the collection rather than recording partial success. No migration or source-row change is required.

Local backend verification: **269 tests / 25 files** passed, including an HTTP/API/SQL/worker flow that saves combined settings, collects both result types, repeats collection without duplicates, and rejects premature candidate activation. The parser fixture confirms one fetch and exclusions, while notice-only operation still produces no candidates. Both package TypeScript checks/builds and Deno API/worker checks passed. Frontend **178 tests / 32 files** passed, for **447 tests** overall. Local Chromium passed combined save/reload, switching back to each separate mode, and 1440px/390px layouts with no page errors or external requests. Its isolated synthetic fixture was removed before building. API and worker **v43 ACTIVE**; readback matches all **33 reachable files** exactly. No authenticated hosted browser or actual combined-source collection acceptance is claimed.

Release `c1d4c13d230adb1e41dd58820e03b2dc5ed630e1` passed [Pages 39249486209](https://github.com/salahassi/tenders/actions/runs/39249486209), including all **447 tests**, TypeScript, Deno, build and publication. Published index HTML, main JavaScript, Sources and SourceDetail bundles match the tested local build byte-for-byte. Hosted API health returns 200; anonymous sources and worker access return 401. Runtime and frontend publication are complete. Existing source modes were not changed; Owners can select the combined mode for a configured source, save it paused and enable it through the usual controls. This final reconciliation changes documentation only.


## October 19: automatic public source reading and separate source discovery

Collection/discovery stage: implementation complete; verification and deployment pending. The Owner requires automatic adaptation to public websites and explicitly separates finding new source URLs from configuring an existing tender source. Enabling an HTTPS catalog source now selects generic model-assisted reading when no extraction profile exists. Existing saved feeds/profiles remain supported. Source configuration defaults to automatic reading with URL/schedule and optional advanced settings; it no longer offers source discovery or combined discovery. The Sources page has a separate Owner-only Discover sources action; suggestions remain proposed until reviewed/enabled.

The worker freezes a fetched public page, validates an exact-hash processing manifest against the current approved provider policy, and uses the existing routing/failover/usage ledger. Model-selected links must exist in the fetched page; extracted titles/fields/quotes must match its text. Observed navigation may cross public hosts, with HTTPS and public-DNS checks on every request/redirect and no cookies/credentials. Page continuations use the existing leased queue and do not refetch frozen evidence during model retries. Newly collected notices receive detail reading before assessment; credential-driven routing can schedule assessments without a manual model-settings row.

This release reads HTML and text PDFs. It does not execute website JavaScript or OCR images/scanned PDFs, submit forms, log in, or purchase documents. Such pages report actual access/format blockers. Each reading is bounded to five pages, 100 results, 60,000 text characters and 200 links per page; coverage limits are recorded. No runtime institution-specific registry is introduced. No catalog entries are bulk-enabled and no candidate source is automatically enabled. Completed page snapshots are removed; measured model usage remains linked to the job. Backend-only RPCs and workspace RLS protect frozen public-page evidence.

Local regression, browser checks, hosted migration, runtime deployment and actual-source acceptance will be recorded separately below.

Local verification passed **273 backend tests / 26 files**, followed by the expanded five-test automatic-source integration suite (274 total current backend tests). Frontend **179 tests / 32 files** passed, with a subsequent 23-test connected-screen regression after adding readable source-job messages. Both TypeScript/build checks and Deno API/worker checks passed. Local Chromium passed five desktop/mobile activation, save/reload, independent discovery and suggestion-review checks without external requests or browser errors. The synthetic fixture was removed before production builds; no authenticated hosted browser acceptance is claimed.

The initial combined migration request returned Invalid or expired requestState; readback proved no objects/history were created. Split migrations preserve the same logic, with worker-only grants also applied in the first transaction. The completion request required one retry after the same tool error and an absence check. All three migrations are now applied; the five-test integration suite passed against their exact file order. API/worker **v44 ACTIVE**. Runtime readback, Pages publication and real-source verification are pending.

Release `a9683d73bee962e899ff2a78671f3f8018f3db67` passed [Pages 39261564447](https://github.com/salahassi/tenders/actions/runs/39261564447). Published index and Sources/SourceDetail bundles match the local build. API/worker v44 readback matches all **36 reachable files** exactly; health returns 200 and anonymous sources/worker requests return 401. Hosted migration versions are `20261019133023`, `20261019133431`, `20261019133453`. Security advisory categories/counts are unchanged (3 private no-policy tables, 22 authenticated security-definer findings, leaked-password protection). No new unindexed foreign key; the new workspace index is initially reported unused.

The audited Owner action enabled the actual Saudi Ministry of Health source with automatic reading, preserving its URL and catalog identity. Its first collection job initially waited behind older assessment retries. A follow-up queue migration gives source work waiting two minutes a turn while preserving accepted remote-request priority, eligibility times and per-workspace lease serialization. Attempts/continuations reset that priority so sources also yield. The six-test integration suite proves both directions; complete regression and hosted source results pending. No synthetic hosted source/opportunity or model result was created.

Queue follow-up `3d5863ae35f2448bbf18b3ae1d06a12ef3c7e93a` passed [Pages 39262169930](https://github.com/salahassi/tenders/actions/runs/39262169930); local full regression passed **275 backend tests / 26 files**. The real Ministry source then fetched **5,475 characters and 111 observed links** but correctly recorded a pre-send DATA_POLICY_BLOCKED result. Investigation isolated the public site's repeated privacy-policy navigation label containing the word “confidentiality”; no model generation was sent for that attempt.

A targeted extraction correction removes only an anchor explicitly labelled as the site's privacy policy and linking to a privacy URL. Actual confidentiality markings and privacy-related tender documents remain unchanged and blocked where appropriate. The real fetched page then retains **5,414 characters, 109 links and all five observed Etimad links** without a false policy block. Worker **v45 ACTIVE**; API remains v44. The old job was audit-canceled and a fresh collection queued, preserving the old evidence/history. Automatic-source/privacy tests pass, including restricted-text preservation; final regression and actual model result pending.

After the privacy-navigation correction, all **276 backend tests / 26 files** passed, both backend TypeScript/build and Deno checks passed; frontend remains at 179 passing tests with unchanged published assets. Worker v45 readback matches all 19 reachable files. A final recovery integration test identified and fixed independent discovery retries trying to load an unrelated source revision: workspace-owned directory jobs now preserve their original directory hash. The expanded **eight-test** automatic-source suite passes, for 277 current backend tests. Full hosted workflow validation and final source observation follow.

Final release `d4061ae3f499b5cd3c8050cc440456997b962b51` passed [Pages 39263110594](https://github.com/salahassi/tenders/actions/runs/39263110594), including **277 backend and 179 frontend tests (456 total)**, TypeScript, Deno and production build/publication. Published index, main JavaScript/runtime, stylesheet and both source-page bundles match the tested local build byte-for-byte. Runtime remains API v44/worker v45 with exact readback; all four source-reading RPCs are service-role-only and the new table has workspace RLS. Final security advisor categories/counts are unchanged; the pre-existing [RLS no-policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) concerns the existing private tables, not source_readings. Queue/retry migration versions are `20261019133956` and `20261019134702`.

Hosted acceptance at approximately **2026-10-19 13:50 UTC**: the actual Ministry page was fetched and its minimized frozen text accepted for a Gemini background request (HTTP 200). The subsequent attempt received Gemini **429**, then failed over to Groq (**413 request too large**) and z.ai (**MODEL_NETWORK_UNCERTAIN**). The source job is **retry_wait / MODEL_ROUND_EXHAUSTED**, retaining its evidence and automatic retry schedule; token usage is unreported, not zero. This proves live collection activation, public-page fetching, authorization, provider submission, failover and recovery. It does **not** prove completed model extraction, following the Etimad link, new opportunities or an end-to-end successful assessment for this source. No completed source result is fabricated. External inference availability/request limits and JavaScript/OCR capability remain explicit acceptance limits. Five sources are now enabled (the four existing collectors plus this Owner-requested Ministry source); the remaining catalog sources were not bulk-activated.

Code, migration, runtime and frontend publication are complete. Local Chromium fixture acceptance is recorded above; authenticated hosted browser acceptance is not claimed. The production source continues retrying unattended. This final reconciliation is documentation only.

## October 19 — grouped failure mail and source retry diagnosis

Owner reports excessive failure mail and no visible discoveries after enabling sources; also requests Discover sources next to Add source. Diagnosis: failure mail was deduplicated per job, so the same model outage emitted one email for each affected assessment. Actual source attempts showed provider 429s, Groq 413/request-size rejection and invalid model output, plus an independent MDLF HTTP 503. Greater Amman subsequently completed automatic collection of 20 actual notices; initial assessment state was 13 queued / 7 NOTICE_DETAILS_NEED_OCR, not a failed activation.

Implementation: recipient-owned failure alert interval (1/6/12/24h; default 1h), durable grouped notification membership, current-job checks before dispatch, preserved per-job in-app history, no replay of already-sent/ambiguous historical deliveries. SMTP acceptance/unknown handling is unchanged. Source model prompts remove duplicated evidence envelopes and task-irrelevant instructions, normalize invisible formatting without permitting invented citations, and include a repair instruction on subsequent attempts. Model validation diagnostics record fixed failure categories without raw text. Provider Retry-After is honored per provider/model/project; a last provider's long delay no longer stalls the whole pool. Previously deferred exhausted rounds are rescheduled within an hour with audit evidence. Source suggestions remain separate; the Discover sources action moves into the Sources header beside Add source.

Status: code implemented; focused tests and full package verification/deployment/hosted readback pending. External HTTP failures, provider availability, and image-only OCR remain distinct from code acceptance. No invented production opportunities or test emails.

Verification/deployment update: backend full suite **282 tests/26 files** passed, frontend **179 tests/32 files** passed, both package typechecks/builds and both Deno entrypoints passed. A subsequent populated-upgrade regression passed with the notification suite (**17 tests**) after correcting the migration audit actor; provider/notification integration checks also passed (**55 tests** before that additional case). Chromium local synthetic acceptance passed at 1440px and 390px: adjacent header actions, independent dialogs, suggestions, and persisted failure interval, with no console errors or external requests. Temporary browser fixture removed from the repository.

Both hosted migrations are applied. Runtime **worker v46 / API v45** is active with canonical shared files. Live preferences retain email enabled and default to a 1-hour failure-summary interval; provider-specific wait repair retained cancellation guards and audit history. Final GitHub publication and hosted after-deployment observations remain to reconcile. Source acquisition is not universally successful: MDLF still returned HTTP 503 independently, MOH/PIF model retries remain outstanding, and seven initial Amman attempts reported OCR (superseded by the redirect diagnosis below). The 20 Amman notices are real database records; no model-based assessment completion is asserted by this entry.

Follow-up diagnosis corrects the initial OCR interpretation: all 20 Amman detail attempts eventually returned NOTICE_DETAILS_NEED_OCR. Independent public inspection of an actual notice URL showed an HTTP redirect to the site's default homepage, including when a normal public cookie jar and listing referrer were used. The generic HTML reader had selected the homepage's first short article and incorrectly labeled it OCR. The follow-up distinguishes redirected/unresolved HTML, image-only pages, browser-rendered pages and empty content; it does not treat homepage text as tender evidence. A new regression covers these distinctions. Existing evidence is preserved and the remaining inability to obtain notice details is explicit.

Redirect follow-up acceptance: final local backend **284 tests/26 files**, frontend **179 tests/32 files**, both typechecks/builds, and both Deno entrypoints pass. Hosted **worker v47 / API v46** now distinguish the HTML blockers. The 20 existing Amman detail jobs were requeued with audit entries, preserving evidence and attempt/failure counts. Main code `2ea592a` passed [GitHub publication 39270466005](https://github.com/salahassi/tenders/actions/runs/39270466005); live assets already contain the adjacent source actions and saved failure-frequency control. Hosted migration versions are `20261019143211` and `20261019143417`. The mailbox held at 42 historical failure deliveries with none newly queued after runtime deployment through the latest readback. MOH's compact source prompt was accepted as a real Gemini background request (200), then the round again exhausted; completion is not asserted. PIF remains in automatic recovery, and MDLF's independently observed HTTP 503 remains external. Final follow-up publication/readback is pending.


Final acceptance: source revision **cf0ce3397fa5d912abb39911ab9a663fbff595f6** passed [GitHub build and Pages publication 39271922928](https://github.com/salahassi/tenders/actions/runs/39271922928), including all 463 tests, TypeScript and Deno checks. Live worker readback confirmed SOURCE_NOTICE_REDIRECTED for the first two Amman rechecks, with 18 still queued at that observation, and zero additional failure deliveries since the runtime release. The corresponding real public HTML also produced SOURCE_NOTICE_REDIRECTED in the corrected local parser. Code, migrations, worker/API deployment, Pages deployment and local browser acceptance are complete. Authenticated hosted browser acceptance and successful model assessment of the new Amman notices are not claimed. Remaining external acceptance: inaccessible/redirected detail URLs, provider quota/availability, and the MDLF 503. The collector continues on schedule; no alert preference or provider was disabled to suppress symptoms. This final reconciliation is documentation only.
