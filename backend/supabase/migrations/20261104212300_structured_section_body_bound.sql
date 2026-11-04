-- The legacy free-text section ceiling predates structured proposal content.
-- Preserve that ceiling for free text while allowing the complete projections
-- already admitted by the generation and authoring contracts. Generated text,
-- authored text/JSON tables and derived compliance matrices are each no longer
-- than their own complete content_blocks JSONB text representation.
--
-- This is a source-relative character bound, not a new global byte allowance.
-- The existing model-step, authoring-request/body, snapshot, export, storage and
-- native-frame limits remain authoritative and unchanged. No body is truncated;
-- full text stays available to content eligibility and final-approval scans.
-- No stored row, procedure, owner, grant, policy or historical hash is rewritten.
alter table public.proposal_sections
  drop constraint proposal_sections_body_check;

alter table public.proposal_sections
  add constraint proposal_sections_body_check check (
    length(body) <= 100000
    or (
      jsonb_typeof(content_blocks) = 'array'
      and length(body) <= length(content_blocks::text)
    )
  );
