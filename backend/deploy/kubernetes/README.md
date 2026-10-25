# DigitalOcean runtime

The deployment keeps the existing Auth, PostgREST, Storage and application API
interfaces. Managed PostgreSQL remains private and every connection verifies
its hostname against the managed database CA. Only the Caddy HTTPS service is
published. API, database, Storage and browser-worker credentials remain in
Kubernetes Secrets; no service credential belongs in the frontend configuration.

The renderer accepts immutable image digests and public coordinates:

```json
{
  "namespace": "tenderdesk",
  "role_prefix": "tdp_app",
  "public_origin": "https://app.example.com",
  "runtime_image": "registry.example.com/runtime@sha256:<64 hexadecimal characters>",
  "frontend_image": "registry.example.com/frontend@sha256:<64 hexadecimal characters>",
  "browser_image": "registry.example.com/browser@sha256:<64 hexadecimal characters>",
  "ocr_image": "registry.example.com/ocr@sha256:<64 hexadecimal characters>",
  "publishable_key": "<public anon JWT>",
  "scheduler_enabled": false,
  "native_workers_enabled": false
}
```

`python3 backend/deploy/kubernetes/render.py --entrypoint-only` creates the
namespace and public load balancer before its hostname is available. Render the
complete deployment with `--config` after selecting the HTTPS origin. The
`build(config)` Python function returns the same object list for the deployment
orchestrator. The renderer refuses mutable images, non-HTTPS origins, service
JWTs in public configuration and string values for activation flags.

Create `tenderdesk-core` privately with `AUTH_DATABASE_URL`,
`STORAGE_DATABASE_URL`, `POSTGREST_DATABASE_URL`, `JWT_SECRET`, `ANON_KEY`,
`SERVICE_KEY` and `PGSSLCA`. All database URLs require `sslmode=verify-full` and
`sslrootcert=/run/db-ca/ca.crt`. Preserve the three login passwords and the JWT
signing secret across deployments. The database administrator credential belongs
only to a short-lived initialization Job; it never enters an application Pod.

`tenderdesk-runtime` holds the new `APP_WORKER_SECRET`, dedicated
`APP_NATIVE_WORKER_SECRET`, and authorized provider/SMTP credentials. Runtime
configuration supplies the internal gateway URL and the public application
origin. The worker and source-browser paths are inaccessible through the public
gateway. Native browser/OCR Pods use their own secret and cannot use the service
key as a native-worker credential.

Run `setup.sql` through the PostgreSQL client while connected to `defaultdb`.
It creates only `tenderdesk_app` and seven `tdp_app_*` roles. Its markers prevent
adoption of unrelated databases, roles or schemas. Repeated runs keep existing
passwords; losing a credential Secret requires restoring its protected copy,
not generating replacement values. Upstream Auth/Storage migrations run next,
followed by the catalog-derived application schema, minimal first-user seed and
the durable dispatcher SQL. A successful Pod startup is separate from schema
and application acceptance.

Storage uses one 20 GiB DigitalOcean persistent volume. Caddy keeps certificate
state on a separate 1 GiB volume. Both deployments use `Recreate` so a rollout
does not attach the same block volume to two nodes. This is a single-replica
configuration with brief rollout downtime. Persistent volumes preserve data
through Pod replacement; off-cluster backups are a separate operational task.
The two existing Kubernetes nodes still determine application availability.

The scheduler remains disabled and native CronJobs remain suspended until
schema, admission settings and service acceptance pass. The relay polls the
transactional database wake record every second and performs periodic recovery;
existing business leases and idempotency remain authoritative. The persistent
worker answers after completing its invocation and drains active requests during
shutdown. Its termination grace period is 240 seconds.

Configuration-map checksums restart frontend/gateway Pods after public
configuration changes. If a credential Secret changes, explicitly restart the
affected deployments so their process environments are refreshed. Never rotate
browser-session encryption or JWT keys as an incidental deployment action.

Build contexts are:

```sh
docker build -f backend/deploy/Dockerfile .
docker build -f backend/deploy/Dockerfile.browser .
docker build -f backend/deploy/Dockerfile.ocr .
docker build -f frontend/Dockerfile frontend
```

Dependencies use the committed lockfiles. The Deno image runs from its verified
build-time cache and does not fetch dependencies at application startup. Managed
cloud development builds can supply the public proxy CA using the optional
`proxy_ca` BuildKit secret; certificate verification stays enabled.

Local checks:

```sh
python3 -m unittest discover -s backend/deploy/kubernetes -p 'test_*.py'
(cd backend && node deploy/kubernetes/test_setup.mjs)
(cd backend && node scripts/runtime/test-dispatcher.mjs)
```

These checks cover ownership guards, durable dispatcher behavior, private
routing, restricted containers and deployment activation. Real destination
acceptance must additionally verify first-user access, membership/RLS,
private files, application commands and background-job persistence before
changing traffic or deleting the source project.
