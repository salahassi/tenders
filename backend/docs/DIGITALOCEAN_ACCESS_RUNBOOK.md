# DigitalOcean access: permanent working reference

Use this file before Kubernetes inventory, diagnosis, acceptance or deployment.
The repository-root [AGENTS.md](../../AGENTS.md) points here so the established
route is available in every checkout, without relying on conversation history.
Last reviewed: November 4, 2026.

## Established route

**GitHub Actions on a GitHub-hosted runner → DigitalOcean management API →
short-lived kubeconfig → Kubernetes using the original cluster certificate
authority and hostname verification → the scoped repository operation.**

The cloud development container can reach DigitalOcean's management API, but its
outbound proxy rejects the Kubernetes upstream certificate with
`CERTIFICATE_VERIFY_FAILED` and HTTP 503. That direct-route limitation remained
in place when the runner route was established. Installing a certificate in the
container does not change the proxy's upstream trust. Reproducing the local 503
is not evidence that the working runner route or application has regressed.

Keep Transport Layer Security (TLS) verification enabled. Do not replace the
cluster certificate, disable hostname checks, unset the environment proxy or
change firewalls as a response to this known local limitation. Diagnose an actual
runner failure from that run's evidence if the established route fails.

## Fixed target and implementation

| Item | Repository target |
| --- | --- |
| Repository | `salahassi/tenders` |
| Cluster / namespace | `tenderdesk-dev` / `tenderdesk-dev` |
| Cluster ID | `a6093a76-a2d6-47fd-8697-579d41ed316f` |
| Region | `sfo3` |
| Kubernetes endpoint | `https://a6093a76-a2d6-47fd-8697-579d41ed316f.k8s.ondigitalocean.com` |
| Application origin | `https://tenderdesk.129.212.166.115.sslip.io` |
| Runner credential binding | GitHub Actions repository secret `DIGITALOCEAN_ACCESS_TOKEN` |
| Shared release preparation | [`digitalocean-runner.py`](../scripts/ops/digitalocean-runner.py) |
| Cluster/TLS validation | [`digitalocean-preflight.py`](../scripts/ops/digitalocean-preflight.py), `validate_cluster` |
| Current implementation and release evidence | [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) |

The release preparation helper validates a checksum-pinned client and the exact
cluster, writes temporary credentials with private permissions, and preserves
original certificate/hostname checks. It also obtains image-registry credentials
for release work. Run it only inside its reviewed workflow, not as a local fix
for the proxy. Workflow cleanup must remove temporary credentials and private
plaintext even on failure. Never print token, kubeconfig, Secret or customer
payloads into this public repository or its public Actions logs.

## Select the operation before dispatch

Inspect the **whole workflow at the intended source revision**, including
conditional steps and the called helper. A name containing "check", "inspect" or
"diagnose" does not by itself establish that the run has no mutations.

| Need | Existing workflow and boundary |
| --- | --- |
| Inspect current workloads and schema | [`doks-access.yml`](../../.github/workflows/doks-access.yml), explicit `mode=inventory` on a revision containing `7b8808174fbf62d53364e56084102a901bc1338d`. It reads metadata through a temporary owned SQL client and verifies cleanup. `mode=bootstrap` still creates isolated compatibility resources and must be selected separately. |
| Exercise backup and restore before release | The same workflow with explicit `mode=restore` on a revision containing the reviewed cloud restore helper and a frozen release manifest. It reads production schema metadata, reconstructs that exact schema in a nonce-bound isolated database, applies the frozen migrations, and exercises genuine Auth/Storage with synthetic fixtures only. It does not copy customer rows or invoke models. Review [`proposal-cloud-restore.py`](../scripts/ops/proposal-cloud-restore.py), its fixture guards and cleanup before dispatch; a successful drill does not prove proposal rendering or production acceptance. |
| Read one proposal's recovery state | [`inspect-proposal-recovery.yml`](../../.github/workflows/inspect-proposal-recovery.yml). Requires the reviewed encrypted selection object and plaintext hash; does not authorize or retry model processing. |
| Check enabled model credential bindings | `doks-access.yml` with explicit `mode=models`. The reviewed [`model-configuration-audit.py`](../scripts/ops/model-configuration-audit.py) reads enabled catalog bindings and only reports provider/model and key/project presence booleans. It never prints aliases, credentials or project values, calls a provider, or changes configuration. Credential presence is not a provider availability or semantic qualification result. |
| Read retained proposal graph evidence | [`diagnose-proposal-graph.yml`](../../.github/workflows/diagnose-proposal-graph.yml). Follow its exact scoped input and private evidence handling. |
| Diagnose HTTPS startup | [`diagnose-https.yml`](../../.github/workflows/diagnose-https.yml). Contains conditional repair steps and private diagnostic upload; inspect trigger/conditions before using it. |
| Release application changes | Select the specific reviewed `deploy-*.yml` and its helper. Check the exact migration set, immutable image, target namespace, rollout and acceptance. Historical release workflows do not automatically include newly added migrations. |
| Evaluate models | [`evaluate-ai-models.yml`](../../.github/workflows/evaluate-ai-models.yml). Live activation is separate from inventory and may make paid provider requests; use only the authorized campaign and its limits. |

The latest successful inventory was verified on the published branch
`codex/proposal-reliability-implementation`, commit
`59c6b309470cacf4dd605325e9a76cb132b88449`, in
[run 41849412810](https://github.com/salahassi/tenders/actions/runs/41849412810).
Use a reviewed ref that contains that commit; older `main` revisions do not have
this input. For that published branch, the exact dispatch is:

```sh
gh workflow run doks-access.yml --repo salahassi/tenders \
  --ref codex/proposal-reliability-implementation -f mode=inventory
```

Check the run head SHA and executed steps after dispatch. The observed schema,
image digests and cleanup receipt are saved in
[`evidence/digitalocean-inventory-20261104-41849412810.json`](evidence/digitalocean-inventory-20261104-41849412810.json).
This evidence file wraps the inventory under `receipt`; release-manifest freezing
requires that exact inner receipt, not the outer evidence wrapper. The intervening
run 41845129587 failed an observer scheduling assumption; the corrected run above
again verified the original certificate authority. That failure was not a TLS
regression.
Ten ready workloads prove inventory readiness at that observation, not proposal
workflow acceptance. The new delivery tables were absent at that time.

Prefer the connected GitHub tools for metadata when available. With an already
configured GitHub CLI, these commands inspect definitions/history only:

```sh
gh workflow view doks-access.yml --repo salahassi/tenders --ref main --yaml
gh run list --repo salahassi/tenders --workflow doks-access.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url,createdAt
gh run view 41571450550 --repo salahassi/tenders \
  --json headSha,status,conclusion,url,jobs
```

Before execution, bind the operation to its reviewed commit, verify the selected
workflow inputs and existing authorization, then dispatch through GitHub Actions.
Do not start a deployment, bootstrap, recovery or model evaluation as a side
effect of an inventory request. Preserve private evidence transport and cleanup.

## Verification and historical proof

Known successful uses of the runner route:

- [October 25 access check, attempt 2](https://github.com/salahassi/tenders/actions/runs/40230328689/attempts/2): cluster readiness and original TLS verification passed.
- [November 3 runtime release](https://github.com/salahassi/tenders/actions/runs/41571450550): verified cluster access and the API/worker update steps passed.
- [November 3 graph diagnostic](https://github.com/salahassi/tenders/actions/runs/41572919737): scoped read-only diagnostic and credential cleanup passed.

For each new operation, record its run URL, exact head commit, relevant executed
steps, result, cleanup and remaining limits in the implementation checklist.
An overall successful workflow whose access/release steps were skipped is not
proof of cluster access or deployment. Historical success is not fresh workload
acceptance. A public HTTP 200 health response alone does not prove database,
worker, model, schema or complete user-flow health.

The original access explanation and migration history remain in
[`DIGITALOCEAN_KUBERNETES.md`](DIGITALOCEAN_KUBERNETES.md). Use this runbook as the
entry point and the dated checklist for current deployment facts.
