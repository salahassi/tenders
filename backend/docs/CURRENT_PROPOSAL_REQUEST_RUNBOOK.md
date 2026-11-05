# One current proposal request through the deployed application

Use [request-current-proposal.yml](../../.github/workflows/request-current-proposal.yml)
only after the release owner verifies the deployed API and worker immutable
image. The permanent [DigitalOcean access reference](DIGITALOCEAN_ACCESS_RUNBOOK.md)
remains authoritative for the GitHub-hosted runner and original certificate
authority. This operation does not deploy or repair infrastructure.

The workflow defaults to verification only. Explicit dispatch requires the
reviewed encrypted selection object, its plaintext SHA-256, the verified
immutable runtime image, and `run_current_request=true`. The selection has only
`version`, `workspace_id`, `opportunity_id` and the immutable predecessor
`plan_id`; keep its identifiers and customer evidence in private transport.
Do not place these values in a public issue, workflow log or repository file.

The request job shares `tenderdesk-digitalocean-production` concurrency with
release operations and accepts only the original Actions attempt. It verifies
the selected blocked historical proposal, its sole active Owner, current source
bindings, expected revisions and absence of leased/reserved predecessor work.
It hashes the retained historical plan, accepted results, verifier pins,
budgets, checkpoints, writes, model attempts and usage, including unknown usage.

An isolated genuine Owner session opens the deployed opportunity page. The
actual `Resume saved work` button must receive a fresh
`PROPOSAL_CURRENT_CONTRACT_REQUIRED` response. The actual
`Start new request with current checks` button must emit the exact canonical
frontend cancel-and-generate batch. Other business mutations are blocked.
The helper neither supplies a frozen context nor changes a historical result.

Before the batch can leave the browser, the parent encrypts and reads back its
exact body and idempotency key. It rechecks current evidence and runtime before
and after persistence. The durable marker derives from the selected workspace,
opportunity and predecessor, independently of runtime image or selection JSON
formatting. An existing marker is a stop condition, including after a transport
error. Do not rerun or create a new selection encoding/key to work around it.
Inspect the private evidence before deciding any separate authorized action.

Chromium's exact detached process identity is captured before session injection
or navigation. Parent failure cleanup terminates that browser group before its
Node driver and confirms process exit. Browser profiles live inside the owned
private runner directory. The isolated Auth session, observer and private runner
files are cleaned on failure as well as success; unconfirmed cleanup fails the
workflow. PID reuse or unproved process-group ownership fails closed.

After a proven start, the read-only issuance observer binds the exact successor,
request and Owner. It records the database's accepted, deadline, persisted
completed and effective completed timestamps. The product deadline remains
`accepted_at + 600 seconds`. Observation never resets that clock or retries work.
An observed terminal request or worker error stops polling immediately; a worker
error preceding request-failure persistence leaves `completed_at` null.
An effective timeout likewise does not invent a persisted completion timestamp.

The observer's independent 630-second maximum is a diagnostic bound, reduced to
the original request's remaining database time plus 15 seconds. A main-thread
watchdog covers blocking runtime inventory and SQL transports within that
remaining budget; SQL also has a 20-second statement and 45-second transport
limit. Cleanup remains a separate bounded workflow phase. Starting observation
late does not grant a new ten-minute business request.

Workflow success requires recorded whole-package issuance: the current generated
draft/version/snapshot, current source and actor guards, successful rendering,
and every required ready volume with byte count/hash metadata. Template, partial
or generated-plan completion alone does not pass. These observations do not
prove a fresh authenticated download, visual quality, provider semantic
qualification or human approval. Run the separately reviewed export acceptance
when actual file download and rendering evidence is required.

The encrypted diagnostic envelope includes before/after historical proofs, exact
request receipt hashes, browser protocol and cleanup state, and bounded issuance
samples. Public output contains only fixed outcomes/codes, counts and the report
hash. Request start, issuance outcome and authenticated download evidence remain
distinct. A failed or unknown workflow is never a claim that a sent request was
rolled back.

Local verification uses synthetic fixtures only. The focused workflow runs
Python protocol/watchdog controls, exact read-only SQL against fully migrated
PGlite fixtures, a canonical generated-delivery/DOCX transition, and actual local
Chromium controls for one send, withheld persistence acknowledgement, driver
death and process cleanup. Only the local browser fixture engine trusts its
throwaway HTTPS certificate; production TLS verification is unchanged. PGlite
and fixture HTML are not native PostgreSQL, hosted Auth or deployed-frontend
acceptance. Deployment and actual customer-request acceptance remain separate
release-owner gates.
