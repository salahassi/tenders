# Current obligation resolution

The source-resolution contract addresses a reproduced gap between source review and generation. A human-confirmed addendum replaced a reviewed obligation for nine terminals with fourteen, while the original source also contained an unchanged requirement for three cabinets. The old reviewed unit was unavailable, but a model could re-extract nine from the retained raw source and label it pending. The existing generated-delivery checks did not revalidate pending rows against supersession authority.

Version one resolves reviewed obligation units. It preserves all raw source passages and immutable review history. A reviewed span can contain several clauses; its coordinates do not authorize deleting that text or unrelated facts.

## Authority and history

New confirmed replacement reviews receive a server-pinned `supersedes_review_revision` under the workspace lock. The predecessor row remains immutable. Existing rows are unchanged: a legacy edge is usable only when its predecessor has one immutable revision. Multiple historical revisions cannot be ordered by `created_at`, because commands in one transaction can share that timestamp. Such edges require explicit review.

The current resolver binds the workspace and opportunity, both review revisions, the complete eight-field meaning tuple, exact source spans, content and block hashes, extraction identity, Unicode coordinates, locator, and current source-authority decision. Every predecessor span must be covered by a confirmed replacement addendum's typed source relationship. The old command's single matching source pair does not authorize a multi-source unit.

A changed predecessor revision, unavailable current source, incomplete authority relationship, or conflicting replacement is unresolved. Revoking a replacement review removes its own edge. In A→B→C, revoking C restores B while the still-confirmed B→A supersession continues to retire A. Revoking or changing source authority invalidates the affected frozen resolution rather than silently retaining it.

## Frozen contract and inventory

New snapshots add `source_resolution_version: 1` and an independent `source_resolution` object with `active_reviews`, `supersessions`, and `unresolved_edges`. The existing source-evidence version-one shape remains intact. The resolver requires executor capability five. Existing paid contexts are never upgraded in place.

The runtime and database use the full typed tuple and exact provenance. A pending candidate for an exact retired unit cannot evade the rule by quoting an enclosing raw chunk. An unambiguous retired candidate is removed only from the planning inventory; the accepted analysis output stays unchanged. Current human-reviewed units are seeded independently with stable IDs and exact reviewed meaning. Unrelated, nonmatching candidates remain pending.

A mixed candidate that reuses an exact retired quantity, date, condition, exception, or consequence requires scoped resolution. There is no natural-language or numeric normalization that asserts equivalence. Generic tuples with no typed items cannot identify an obligation from a broad passage; pending overlap remains unresolved. An explicitly confirmed current review can identify its own unit. Multiple indistinguishable matches, partial coverage, or unrelated extra passages are unresolved rather than silently discarded.

Analysis advancement independently validates the supplied retirement and seeding audit against the stored successful analysis outputs. Every retirement names its original step, array index, predecessor revision, and replacement revision. Every current unit must be present with the canonical stable ID. Preserved rows cannot be replaced with invented meanings. The checked audit is saved on the advance step, while original analysis bytes remain intact.

## Current issuance and recovery

Requirements persistence, generation advancement, generated delivery preparation, current generated snapshot/artifact access, and ordinary export checks use the same resolution authority for pending and confirmed requirements. Changed frozen resolution or unresolved edges stop current issuance. A legacy unmarked plan with effective supersession requires a fresh generation; its history remains available without being rewritten or promoted.

A fresh retry of such a proposal returns the existing `PROPOSAL_CURRENT_CONTRACT_REQUIRED` response with the existing current-request action details. The established user interface can cancel the old request and start a new request. Idempotent original receipts remain original receipts. Restore retains the existing scoped Owner/committing-session checks and clears imported reviewer assurance; the new column does not turn imported history into current authority.

## Verification boundary

Focused local tests cover exact nine→fourteen resolution with unchanged three, broad spans, pending persistence bypass, mixed tuples, predecessor edits, revocation chains, partial multi-source authority, legacy timestamp ambiguity, audit tampering, actual analysis advancement, current-request successor creation, a 64-review catalog, and restored history. Runtime integration, worker-five claims, release qualification, deployment, and hosted acceptance are separate gates.

These controls establish provenance and deterministic resolution of typed decisions. They do not prove arbitrary model interpretations correct, turn authored verifier responses into observed provider success, or grant final proposal approval. Ambiguous interpretations still require bounded resolution or an explicit error; the original source and every historical decision remain available for that process.
