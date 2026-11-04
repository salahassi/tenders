# Saved delivery acceptance, selection version 2

`accept-saved-delivery.yml` is an explicitly activated, read-only acceptance
workflow. It does not prepare a proposal, retry a job, approve a version, render
in the browser, upload an artifact or create business fixtures. Select an
authorized existing current snapshot, or a record in an explicitly isolated
hosted test workspace. Synthetic production records are prohibited.

The older completed-plan acceptance workflow retains its version 1 selection
and strict completed-proposal prerequisite. This separate harness can observe
the first template and partial progress before a complete AI version exists.

The encrypted selection contains exactly these fields:

```json
{
  "version": 2,
  "workspace_id": "<reviewed workspace UUID>",
  "opportunity_id": "<UUID>",
  "proposal_id": "<UUID>",
  "snapshot_id": "<current immutable delivery UUID>",
  "delivery_revision": 1,
  "content_hash": "<exact 64-character lowercase SHA-256>",
  "expectation": "template",
  "input_state": "insufficient",
  "package_status": "ready",
  "plan_id": null,
  "issuance_id": null,
  "issuance_outcome": null,
  "wait_seconds": 0
}
```

`expectation` is fixed before observation: `template`, `partial`, `substantive`
(explicitly reviewed authored draft), or `issued` (generated draft with the
canonical issued request receipt). `input_state` is `available`, `partial` or
`insufficient`. `package_status` is `preparing`, `blocked` or `ready`. A passed
pending-state observation reports `deliverable_verified: false`; it never
claims a downloaded document. A human-reviewed substantive draft does not count
as automatic AI issuance. Every supported delivery remains a draft, distinct
from final approval/export.

When checking an AI request, supply all three of `plan_id`, `issuance_id` and
`issuance_outcome` (`active`, `issued`, `failed`). They are mandatory for the
`issued` expectation. The server's accepted time and deadline must differ by
exactly 600 seconds and remain unchanged across polling. Issued completion must
precede that deadline and reference the selected snapshot. Known terminal errors
end an issued-state wait immediately; an available template can be inspected
alongside an explicitly expected failed request without being called issuance.
`wait_seconds` is an observation limit from 0 through 600, never a reset of the
canonical request deadline.

The preflight checks the exact current snapshot, proposal revision, source
currentness and one active allowlisted Owner using a read-only transaction. The
existing Auth generate-link/verify flow creates a genuine isolated session;
it sends no invitation or email and does not change a password. Business reads
use that session. Service keys never reach the verifier. Session logout and
private temporary-file cleanup run even on failure.

For a ready package, the verifier requires its succeeded durable job and the
exact complete combined or technical/financial volume set. It downloads bytes
through the authenticated application API, compares registered size/SHA-256,
and runs the application's canonical DOCX validator, including yellow
placeholders and volume rules. It rechecks actor, active selection, current
source context, package and request after download. A ready first volume in a
pending two-volume package must refuse download. Requests are GET-only, redirect
blocked, individually time bounded and response-size bounded.

Reports and actual documents travel only in the existing encrypted private
bundle transport. Public workflow output contains counts, expectation/state,
verification flags and report hash, not documents, selected identities, tokens
or private error bodies. No hosted invocation was made while implementing this
harness. Local transport fixtures do not prove genuine hosted Auth/Storage,
browser tab closure, visual layout, measured capacity or production latency.
