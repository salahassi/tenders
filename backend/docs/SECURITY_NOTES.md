# Backend security notes

- Browser identity is verified by Supabase Auth on every protected request; browser roles and workspace IDs are not trusted.
- Both active membership and approved GitHub identity are required for reads and commands. Owner bootstrap requires a real verified Auth identity and is one-time.
- RLS protects direct reads. Browser roles have no direct application-table writes or worker RPC privileges. Cross-entity references carry workspace IDs.
- Public command and membership RPCs execute as the caller. The guarded transactional command routine is in the unexposed private schema. The hosted platform's public RLS event helper is not executable by browser roles.
- Commands serialize workspace quota reservations, check expected revisions, record idempotency results and append audit events in the same database transaction.
- Source URLs are validated as HTTPS, but arbitrary server fetching is disabled until deployment-controlled hostname/network validation is implemented. Merely approving a source never performs a fetch.
- File bytes use private generated paths. Original MIME, signature, size and hash are validated; Office expansion is limited. This is bounded format validation, not an antivirus certification or independent proof of document completeness.
- Model, payment, purchase, submission and external-message execution are absent. Model jobs remain blocked. The historical Gemini name has not been silently activated.
- Worker authentication is distinct from user JWT authentication. Lease completion requires the current lease token; expiry recovery blocks uncertain work instead of repeating inference.
- Service credentials and scheduler secrets are never browser configuration. Do not log signed URLs, raw SQL diagnostics, original documents, or model payloads.
- Local PostgreSQL and HTTP tests do not establish production readiness. Hosted RLS/private-bucket checks and unauthenticated API/worker denial are verified; real approved identities, authenticated Storage uploads and cron remain activation requirements.
