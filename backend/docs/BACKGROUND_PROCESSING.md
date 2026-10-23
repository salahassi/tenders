# Background processing

## Public notice OCR

The public-source workflow runs browser reading and scanned-notice OCR as two
independent GitHub Actions jobs. Each has a separate runner and concurrency
group; a slow or failed browser run does not consume the OCR worker's time.
The OCR worker processes at most ten requests within a nine-minute admission
window, using native Arabic/English Tesseract and the existing private,
hash-bound queue. Both jobs use the already authorized workflow's short-lived
GitHub identity; no new persistent credential is introduced.

The Review inbox and Activity & jobs display OCR waits in purple as
**Awaiting OCR**. This is a reading dependency, not a completed assessment or a
technical failure. Its underlying durable parent checkpoint retains
`retry_wait` / `NOTICE_OCR_PENDING` for compatibility. The main queue excludes
parents with current queued/running OCR receipts; ready, terminal or stale
receipts allow the normal guarded continuation. Actual extraction failures
remain visible under Needs attention. Original business decisions are unchanged.

The browser starts a saved generation plan and observes its database status. Closing the page does not cancel the plan. Model request state, completed stages, retry times and leases are stored in Supabase.

The cron dispatcher authenticates to the worker. The worker returns `202 accepted` after authentication and registers its task with `EdgeRuntime.waitUntil`. A 202 is acceptance, not success; job/model activity records determine the result. Only one live workspace job lease can execute.

## Remote requests

Gemini Interactions and OpenAI Responses can return a request ID before generation finishes. The worker saves that ID before releasing the job. A subsequent invocation retrieves the same request. A temporary GET failure or rate limit reschedules polling; it does not send another generation or abandon the pending request for failover. An expired result or definitive terminal failure permits the ordinary recorded recovery path. Completed/canceled requests preserve measured or unknown usage accurately.

OpenAI background submissions use `store: true`; successful requests are deleted after the application's result is saved. Provider retention rules still apply. New checkpoints bind provider, configured project, model and input hash. Exact content authorization is rechecked on continuation.

## Streaming and limits

Chat-compatible synchronous providers and Claude use SSE in the detached worker. Received data resets the 90-second idle timer. Missing usage is unknown, reasoning text is not retained, and missing completion markers never produce a complete response.

The detached invocation reserves 130 seconds for model work within Supabase's documented 150-second free worker lifetime. Each generation gets 90–120 seconds according to remaining time. A later provider gets a fresh invocation when less than 90 seconds remain. Successful stages and round checkpoints survive this handoff; an unfinished synchronous HTTP response itself cannot be resumed without a provider retrieval API.

`waitUntil`, SSE and an HTTP 202 do not remove the platform's hard lifetime limit. A single synchronous model request requiring more than this bound still needs a persistent external execution environment, or smaller individual generation tasks. No such environment is currently configured. Do not present the development environment or a local test process as permanent hosting.

Sources checked October 20, 2026:

- [Supabase background tasks](https://supabase.com/docs/guides/functions/background-tasks)
- [Supabase runtime limits](https://supabase.com/docs/guides/functions/limits)
- [OpenAI background mode](https://developers.openai.com/api/docs/guides/background)
- [z.ai chat completion and streaming](https://docs.z.ai/api-reference/llm/chat-completion)

Actual provider availability (including 429 responses) remains separate from connection lifetime. Operational logs retain each attempt; no test fixture or inferred timing constitutes a successful hosted proposal.
