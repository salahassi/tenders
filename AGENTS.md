# Working in this repository

This release is the frontend-only Tenderdesk demo. Preserve truthful demo labeling and zero external model/payment/portal calls. Do not implement simulated connected success.

- Read `docs/FRONTEND_HANDOFF.md` before connecting services. Full future requirements are in `docs/IMPLEMENTATION_SPEC.txt`.
- Use shared types, domain rules, and `AppProvider`; keep business calculations out of presentation components.
- Preserve Arabic content, keyboard access, visible focus, mobile layouts, unknown values, and explicit loading/error states.
- Content or supporting evidence changes must invalidate approved proposal versions.
- Do not add secrets, credentials, real company claims, customer documents, or sensitive data to the repository or fixtures.
- Install from the lockfile. Before a handoff, run `npm run typecheck`, `npm test`, and `npm run build`.
- Record verification limits. jsdom tests are not real-browser visual QA or proof of server authorization.
