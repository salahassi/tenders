# DigitalOcean Kubernetes access

The owner requested deployment to the existing `tenderdesk-dev` cluster. The
cloud development environment can reach DigitalOcean's management API, but its
outbound Envoy proxy rejects the Kubernetes server certificate. Installing a
certificate in the development container does not change the proxy's upstream
trust configuration.

The `Check DigitalOcean Kubernetes access` GitHub Actions workflow runs the
initial connection check on a GitHub-hosted runner. It uses the cluster's own
certificate authority, with certificate and hostname verification enabled. It
does not require a custom domain or a replacement certificate. This moves the
Kubernetes client to the runner; it does not repair the development environment's
direct connection.

## Credential setup and first run

In this repository's **Settings → Secrets and variables → Actions**, add the
repository secret `DIGITALOCEAN_ACCESS_TOKEN` through GitHub's secure input. Use a
DigitalOcean token limited to the permissions required to read the selected
cluster and obtain its kubeconfig. Never put its value in a workflow, commit,
issue, pull request, or chat. The integration available during preparation could
read workflows but received HTTP 403 when accessing the Actions secrets API;
repository administrator status did not grant that integration secret access.

The workflow requests a kubeconfig with a 900-second lifetime, writes it with
owner-only file permissions in the runner's temporary directory, and removes
the credential directory in an unconditional cleanup step. It installs the
matching Kubernetes client with SHA-256 verification, validates the configured
server and TLS settings, then checks server readiness, aggregate resource
counts, and deployment permissions. It does not print kubeconfig contents,
tokens, node addresses, application logs, or Secret objects. This repository is
public, so workflow output must remain limited to these operational checks.

The preparation branch is `codex/doks-access`. Pushing changes to its access
workflow triggers the read-only check. If that run stops because the secret is
missing, add the secret and use **Re-run all jobs** on that run. After the workflow
is present on the default branch, it can also be started through **Run workflow**.

The selected cluster is:

- ID: `a6093a76-a2d6-47fd-8697-579d41ed316f`.
- Region: `sfo3`.
- Reported server version during preparation: `1.37.0-do.1`.
- Endpoint: `https://a6093a76-a2d6-47fd-8697-579d41ed316f.k8s.ondigitalocean.com`.

The workflow is deliberately bound to this cluster. If the cluster changes or
is upgraded, review the configured identity and client version before running.

## Deployment boundary

A successful connection check is a prerequisite for deployment, not evidence
that Tenderdesk is deployed. The current application uses a React frontend and
Supabase-hosted authentication, storage, Edge Functions, database functions and
scheduled work. The repository does not yet contain a Kubernetes application
deployment or a compatible replacement for those backend services.

The Owner selected complete migration to DigitalOcean. Moving the complete
application to Kubernetes and DigitalOcean managed PostgreSQL requires an
explicit migration of authentication, storage, function runtimes,
database roles and extensions, scheduled work, secrets, origin configuration,
and existing data. A managed PostgreSQL address cannot replace `SUPABASE_URL`.

Inventory the cluster and existing workloads before applying manifests. Record
the source revision, target namespace, rollout result and application acceptance
in `IMPLEMENTATION_CHECKLIST.md`. No existing application, database migration,
public load balancer, or environment publication is part of this access check.

## Complete migration sequence

The proposed target retains Supabase-compatible service interfaces while moving
their execution and data to DigitalOcean. This preserves the application's
authentication and authorization contracts instead of replacing them during
the infrastructure move. It still requires implementation and hosted validation.

| Component | Target and validation needed |
| --- | --- |
| React frontend | Serve the existing build from Kubernetes; configure the final HTTPS application origin and authentication callbacks. |
| Authentication and data API | Run compatible Auth and PostgREST services; preserve user IDs, password hashes, identities, database roles, grants and row-level security. |
| Application API and workers | Package the existing Deno functions; preserve user authentication, private dispatcher authentication, leases and idempotency. |
| Database | Validate the existing PostgreSQL 18 managed database against actual source schema and role requirements before selecting it as the destination. |
| Original files and exports | Provide object storage on DigitalOcean behind the compatible Storage API; retain private access, object keys, ownership and byte hashes. |
| Scheduling and secret storage | Verify `pg_cron`, `pg_net` and `supabase_vault` availability, or implement tested Kubernetes replacements for both periodic dispatch and immediate queue wakeups. |
| Browser and optical character recognition workers | Replace GitHub-issued workload identity if moving these workers into Kubernetes; update the existing hardcoded audience and gateway URL. |

1. Complete the runner connection check and inventory the live cluster. Obtain
   authorized source database export and private Storage read access, plus the
   destination object-storage credentials. Do not assume an API that lists secret
   names can recover their values.
2. Compare the live source schema, extensions and privileges with the target.
   The repository contains 132 canonical SQL migrations, with documented hosted
   timestamp/body differences. Do not blindly replay those files as a migration
   of the populated source system.
3. Build the isolated destination with schedulers and external processing paused.
   Transfer a protected logical snapshot that includes Auth users, identities,
   password hashes, business rows and grants. Copy private objects and compare
   their hashes; preserve UUIDs and relationships.
4. Validate invitation-only sign-in, membership and role boundaries, anonymous
   denials, database authorization, original upload/download, Word exports,
   worker leases and retry behavior. Passing local tests does not establish
   these destination acceptance results.
5. Before cutover, establish the trusted HTTPS endpoint and callback/origin
   settings, freeze source writes, reconcile accepted external requests, and
   apply a consistent final transfer. Switch the application only after matching
   data and file checks pass. Enable exactly one intended set of workers and
   schedules to avoid duplicate model requests or notifications.
6. Retain the source for rollback. Before destination writes begin, traffic can
   return to the source. After destination writes begin, reconcile new data before
   reverting; simply switching back could lose work.

The application's own backup is **not** a transparent platform-migration export.
As described in [OPERATIONS.md](OPERATIONS.md), it excludes Auth accounts, access
grants, invitations and secrets; restoration intentionally cancels unfinished
jobs, disables models and invalidates permissions and approvals. Use a verified
database and object-storage migration for continuity instead.

The first corrected workflow run, [40230328689](https://github.com/salahassi/tenders/actions/runs/40230328689),
stopped at the missing repository secret before contacting Kubernetes. No
destination application or data has been deployed by that run.
