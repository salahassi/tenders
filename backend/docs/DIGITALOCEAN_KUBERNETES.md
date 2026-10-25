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

The workflow requests a kubeconfig with a one-hour lifetime, writes it with
owner-only file permissions in the runner's temporary directory, and removes
the credential directory in an unconditional cleanup step. It installs the
matching Kubernetes client with SHA-256 verification, validates the configured
server and TLS settings, then checks server readiness, aggregate resource
counts, and deployment permissions. It does not print kubeconfig contents,
tokens, node addresses, application logs, or Secret objects. This repository is
public, so workflow output must remain limited to these operational checks.

The preparation branch is `codex/doks-access`. Pushing changes to its access
workflow or probe helper triggers the checks. Database queries are read-only;
the compatibility probe creates and removes temporary Kubernetes resources.
If that run stops because the secret is
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

After the credential was added, [attempt 2](https://github.com/salahassi/tenders/actions/runs/40230328689/attempts/2)
succeeded: Kubernetes `v1.37.0`, two Ready nodes, 14 Running pods, and permission
to create Deployments in `tenderdesk-dev`. The cloud proxy itself remains
unchanged; this verifies the GitHub Actions execution path.

## Database and source compatibility inspection

The extended workflow runs `backend/scripts/ops/digitalocean-preflight.py` after
the connection check. This requires the DigitalOcean credential to read the
selected managed database connection details and CA, as well as the cluster
kubeconfig. It also uses the repository secret `SUPABASE_ACCESS_TOKEN`, when
available, for a read-only management query against the existing source project.
Missing source access is reported separately from the target result.

The target probe creates an isolated, uniquely named Kubernetes namespace and
a short-lived Job using the digest-pinned official PostgreSQL client image.
The client connects to the database's private endpoint with `sslmode=verify-full`
and the database CA. It reads only version, schema, extension and privilege
metadata. The database credential Secret is owned by the expiring Job, and
explicit cleanup verifies namespace ownership before deletion. An unconditional
workflow cleanup runs again before removing the runner's kubeconfig. The probe
does not change database schema/data, open firewall rules, expose a public
service, or provision another database.

Public workflow logs contain only selected compatibility metadata and bounded
failure codes. A successful read-only inventory does not prove that compatible
Auth, Storage and database roles can be bootstrapped; those still require
isolated installation and authorization acceptance before restoring source data.

### Verified results and next prerequisite

[Run 40232030191](https://github.com/salahassi/tenders/actions/runs/40232030191)
on source `d6ee54fb2d1904788eb1f68d59d5dde0b20cc6c7` successfully ran the temporary
PostgreSQL client inside Kubernetes, connected to the private managed database
with full TLS verification, and removed its namespace and credential resources.

The selected PostgreSQL 18 database reports CREATE ROLE and CREATE DATABASE
privileges without superuser, zero public tables, and no Auth or Storage schema.
`pgcrypto`, `uuid-ossp`, `pg_trgm` and `pg_cron` are available but not installed.
`pg_net` and `supabase_vault` are unavailable. The current dispatcher and queue
wakeup design therefore require adaptation, or a deliberately selected compatible
database deployment; applying the existing schema unchanged is not validated.
The probe does not test elevated role creation, row-security bypass capability,
extension installability or actual Auth/Storage bootstrapping.

The independent source query stopped because `SUPABASE_ACCESS_TOKEN` was missing
from repository secrets. That token is an optional route for source inspection
from the runner. The connected Supabase Model Context Protocol (MCP) integration
has separately exported 116 application, Auth and Storage tables containing
81,124 rows, together with schema, ownership, routine and policy definitions and
the hosted migration history. Those protected files remain outside this public
repository. The reads were not one transaction, and no executable restore or
destination restoration has been verified. Object metadata is included; the
private file bytes and runtime credentials remain separate transfer tasks.

The workflow now reports an absent optional source token as `not_run`. It still
fails for an invalid supplied token or a failed target check. A successful target
run does not imply source inspection or complete migration readiness.

## Isolated compatible-service bootstrap

The Owner authorized the next compatibility test. The workflow creates a new,
nonce-named logical database on the existing managed PostgreSQL cluster and
seven uniquely named roles. It never adopts an existing name or restores source
rows. Original cluster and database certificate verification remain enabled.

The isolated Job runs digest-pinned Auth 2.197.0, PostgREST 14.18 and Storage
1.81.0. Storage uses a disposable filesystem volume for two automated fixture
objects; this is not the production storage design. No public Service or load
balancer is created. Namespace network policy permits database traffic to private
addresses and DNS, while the HTTP acceptance client reaches native sidecars
through loopback. No model provider or SMTP credentials are supplied.

The test deliberately avoids superuser and `BYPASSRLS`. The service role inherits
the isolated public-table and Storage owners; ordinary request roles inherit
neither. Actual HTTP tests must show that invitation-only Auth, password sign-in,
cross-user row isolation, ownership-change denial, private object access and
privileged service operations work together without disabling row-level security.
This is a proposed ownership arrangement for evaluation, not evidence that all
production functions and grants can already be restored under that arrangement.

Database and role comments identify the exact run. Cleanup checks those markers,
the database owner, the namespace UID and ownership labels before removing only
the generated database, roles and Kubernetes resources. The suspended parent Job
retains its credential Secret until guarded SQL cleanup finishes. Both the main
helper and unconditional workflow step attempt cleanup; a cleanup failure is an
explicit failed result and requires inspection before another bootstrap. A hard
runner termination can leave the isolated logical database or roles behind.

Local checks and live execution results are recorded separately in
`IMPLEMENTATION_CHECKLIST.md`. Passing this bootstrap would establish a narrow
service compatibility result. Scheduler adaptation, production schema mapping,
source/file restoration, HTTPS configuration and application acceptance still
precede any cutover.

### Verified compatible-service result

[Run 40235951433](https://github.com/salahassi/tenders/actions/runs/40235951433)
on `72a10d63318f98071e5e12ca240b4f2c31ebc8bf` passed all seven HTTP acceptance
groups on the existing PostgreSQL 18 server. The pinned services completed their
migrations, real test users accepted an invitation and signed in with passwords,
PostgREST enforced cross-user and anonymous denials, and private Storage uploads
and downloads preserved exact fixture bytes. Privileged service access worked
through scoped owner inheritance while ordinary-user RLS stayed effective.

The database, seven roles, namespace and temporary credentials were removed
after the test. This verifies the isolated role/service arrangement; it does not
restore or validate the actual TenderDesk schema, production users or original
files. The next implementation checkpoint is mapping the production schema and
grants to the validated arrangement and replacing its dispatcher dependencies,
with durable storage and HTTPS configuration required before application cutover.


## Permanent application deployment and minimal data scope

The deployment workflow builds digest-addressed runtime, frontend, browser and
OCR images in the account's integrated DigitalOcean registry. It obtains
short-lived Kubernetes/push credentials and a separate durable read-only image
pull credential. Only the selected `tenderdesk-dev` namespace and marker-owned
`tenderdesk_app` logical database and `tdp_app_*` roles may be initialized.
Existing unrelated workloads or unmarked database objects are rejected.

Application DDL is generated from the private catalog by
`backend/scripts/ops/production-schema/build_schema.py`. Run the pinned upstream
Auth/Storage migrations before this DDL. The companion `build_minimal_seed.py`
selects only the earliest active confirmed email/password Owner and operating
configuration. Neither business history nor original files is imported. Runtime
signing and worker secrets are new, so the Owner must sign in again with the
preserved password. No existing hosted access token is reused.

The private schema/seed bundle is encrypted before upload to the private
`tenderdesk-migration-a6093a76-sfo3` Space. The workflow independently downloads
and authenticates it. This bucket is a private migration transport, separate
from the application's persistent object volume. Do not commit or attach its
plaintext bundle, database credentials or private manifests. Temporary Spaces
keys and runner data are removed; no private workflow artifacts are published.

The permanent runtime includes a transactional database wake outbox and a
one-second polling relay plus periodic recovery. Both direct queue wakes and
lost/in-progress invocation recovery retain their existing business leases and
idempotency guards. The relay and browser/OCR schedules remain disabled during
restoration. Apply `dispatcher.sql` and `auth-invitations.sql` as the application
owner after the application schema, using the prefixed service/auth role
parameters. The Auth hook permits account creation only for a pending valid
Owner-issued invitation; email confirmation remains enabled.

The frontend receives public `apiUrl`, anonymous `publishableKey`, and
`appOrigin` through `/runtime-config.js`; privileged keys never enter that file.
Its container serves the application on the HTTPS gateway. The gateway denies
public access to worker and source-browser interfaces. Without a supplied custom
origin, the deployer assigns a temporary `tenderdesk.<load-balancer-IP>.sslip.io`
hostname and obtains a trusted certificate through Caddy. Production custom DNS
can later replace that origin through `TENDERDESK_PUBLIC_ORIGIN`.

Supabase MCP does not return deployed provider keys or SMTP passwords. The
workflow provisions any matching repository secrets into the runtime Secret;
SMTP sender fields are derived from its configured From address. First-Owner
password login can operate without SMTP, while new-account confirmation and
password recovery need a real SMTP account. Model operations need their actual
provider credentials. Source deletion remains conditional on verifying these
features, persistent files, permissions, scheduling and the frontend against the
new server. A successful container rollout alone does not satisfy that condition.


The verified permanent release passed
[40244862158](https://github.com/salahassi/tenders/actions/runs/40244862158):
ten ready Deployments, nine public acceptance groups and eleven background
activation groups, with preserved initial restoration and confirmed administrator,
fixture and runner cleanup. `promote-verified.yml` can deploy the immutable
component digests only after `verify-release.py` checks the successful application
validation, unchanged application/operations inputs and the complete static native
module graphs. This avoids repeating unchanged native image uploads after the
registry upload timeout observed in the full-build workflow.

The canonical frontend is `https://tenderdesk.129.212.166.115.sslip.io`.
The old Pages bookmark publishes only a redirect. Provider credentials and SMTP
are still unconfigured in Kubernetes; model admission remains paused and the
source project remains intact until the Owner's complete-operation condition is
satisfied. Background maintenance and native schedules are active on the new
cluster. Use the recorded immutable release and current deployment instructions
when updating the runtime; initial empty-target acceptance is not a business-data
restore or a general instruction to reseed a used workspace.
