# Runtime qualification and revision-label promotion

The release must use the filesystem and runtime configuration actually exercised
in the retained native receipts. A matching Git revision label alone does not
establish that identity. `runtime-qualification.py` binds the qualified local
image `sha256:176bcf738676421ebc58d26cd7bc2a29910d0242635de6084129a06701a9e4f8`;
`proposal-delivery-images.py` now requires this binding for both new and reused
runtime candidates. Frontend and OCR image preparation retains its existing
source-build contract.

## Recorded local proof

[The November 5 qualification receipt](evidence/runtime-qualification-176bcf-20261105.json)
records the actual image inspection, ordered 17 RootFS diff IDs, complete Docker
`Config` except its separately recorded labels, platform, and all 146 entries
in `/app` obtained as a tar inventory from a never-started container. The exact
130 regular files in the five Dockerfile COPY roots match corrected source
`19498666b511a29c251923baa75bf42c88a0c6f0` byte for byte. The recorded pinned Deno
base has ten ordered layers, all an exact prefix of the qualified image. The
candidate was newly built from that source and exercised in four sequential
native runs. A separate never-started container supplied the tar inventory and
was removed. Those build, inventory and native steps did not publish or deploy;
the subsequent actual publication is recorded separately below.

The full input path set is checked, including unexpected untracked or ignored
entries and empty directories within COPY roots. Symlinks and special files are
rejected before reading them. Git file type and executable mode are checked;
ordinary checkout permission differences such as `0600` versus `0644` are not
misrepresented as runtime changes. The actual image's modes and ownership are
recorded separately and remain fixed through identical RootFS layers. No image
permission normalization is performed. A Dockerfile-specific ignore override is
rejected. Dockerfile and root `.dockerignore` hashes are frozen.

Deno config and lock files are copied runtime inputs. Backend/frontend npm
manifests and lockfiles are separately bound to the native harness receipts;
they are not claimed as Docker COPY inputs. This build records its command,
recipe, image inspection, build-log hash and source inventories before and after
execution in [the build receipt](evidence/runtime-build-176bcf-20261105.json).
The fixed `model.ts` hash is
`e98fdffb10e6a07aea33c34d214b6432081955a37aa9aa8d66e1ee4d97ea2ae8`.
The new evidence does not reinterpret the older image's retrospective recipe
binding or claim that arbitrary rebuilds reproduce either image.

The receipt hashes and checks four new evidence files, including their actual
image identity and copied-source hashes:

- [Two warm API downloads](evidence/native-api-owned-snapshot-steady-176bcf-20261105.json) exercise the actual application programming interface (API) handler and native verifier with migrated synthetic input and emulated authentication, remote procedure calls and Storage. Neither forced garbage collection nor a parent restart occurs between the two requests.
- [One fresh-parent API download](evidence/native-api-owned-snapshot-fresh-176bcf-20261105.json) uses the same frozen input and exact retained DOCX artifact in a separate container.
- [Reviewed DOCX completion](evidence/native-reviewed-docx-handler-176bcf-20261105.json) exercises the actual handler and verifier with the unchanged 3,177,596-byte ordinary artifact and synthetic `ordinary-2` server pin.
- [The 100-command batch](evidence/native-api-batch-capacity-176bcf-20261105.json) exercises the actual-image handler and transport with real isolated PostgreSQL/PostgREST, synthetic authentication and a loopback adapter. The harness replaces the main program while retaining the image entrypoint and immutable product code.

All API runs use a 384 MiB memory limit and 700 millicores. Exact results are:

| Frozen fixture | Observed operation time | Cgroup peak bytes | Remaining memory below the configured limit |
| --- | --- | ---: | ---: |
| Owned snapshot, two warm requests | 110.510s and 110.887s | 384,602,112 | 17.21 MiB |
| Owned snapshot, fresh parent | 104.787s | 378,441,728 | 23.09 MiB |
| Reviewed DOCX | 34.087s | 359,337,984 | 41.31 MiB |
| 100-command API batch | 56.703s full stream | 161,759,232 | 229.73 MiB |

The batch delivers 100 ordered results, 412,758,765 bytes and 1,600 chunks, with
SQL/result hashes, replay, slow-consumer admission, cancellation and reacquisition
verified. All tracked sources and fixtures remain unchanged, and all disposable
containers are removed. No out-of-memory event or actual swap is observed.
The document harness does not explicitly disable swap; its host reports zero
available swap. The batch harness explicitly disables swap. Database resource
limits are local safety limits, not measurements of managed database capacity.

The minimum newly observed memory margin is 17.21 MiB. This measurement does not
establish a causal performance improvement over the preserved earlier runs,
universal admitted capacity, or concurrent issuance capacity. The
[orchestration activity record](evidence/native-orchestration-activity-scope-176bcf-20261105.json)
discloses four metadata tests near the warm-run end (0.002s reported test body;
interpreter startup/import time not measured), ordinary metadata inspection and
an isolated git commit during the sequence. No claim of zero other processor
activity is made. Live-provider quality, hosted acceptance, production service
levels and desktop Word behavior remain separate qualifications.

## Exact publication and promotion sequence

The [new publication record](evidence/runtime-qualified-publication-176bcf-20261105.json)
now records actual push, exact immutable-digest pullback and layer/configuration
verification for
`registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:996e1ea5b3ff63ca4ea0e5ef75dc45c7d5a83f0c8a2501539bb0a8fc669fbfb2`.
Temporary publication credentials were removed. This is publication of the
qualified `176bcf` image, with no application deployment or customer mutation.
The local image ID is not substituted for the registry manifest digest. The
[older qualification](evidence/runtime-qualification-89af-20261104.json),
[older publication](evidence/runtime-qualified-publication-20261104.json) and
all earlier native receipts remain unchanged; they do not qualify the corrected
`model.ts` bytes.

The subsequent [actual local promotion probe](evidence/runtime-label-promotion-176bcf-20261105.json)
produced image `sha256:c8b6db388e67213bf07eb4bac3d72072d013629bcdd484a86a33878611932fd1`
for revision `621bac58f5486a40b03d5f93827a0322e1af3866`. It preserves all ordered
RootFS layers and runtime configuration except the revision label and was not
pushed or deployed. The exact recipe was:

```dockerfile
FROM registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:996e1ea5b3ff63ca4ea0e5ef75dc45c7d5a83f0c8a2501539bb0a8fc669fbfb2
LABEL org.opencontainers.image.revision=621bac58f5486a40b03d5f93827a0322e1af3866
```

The release independently verifies its current checkout's complete input closure,
pulls this exact qualified digest and requires its original image ID, layers,
platform, Config and labels. A release-head candidate uses only these FROM/LABEL
instructions, with the actual reviewed release revision in the label.

The build has network disabled and pull disabled after the verified digest pull.
There is no COPY, ADD or RUN, filesystem write or cache rebuild in this recipe.
Before push, and again after publication, the candidate must retain the exact
ordered RootFS and every `Config` field except `Labels`. Its labels must equal
the qualified labels plus only the requested revision-label value. The generated
image ID and history metadata may change; no equality claim is made for those
metadata fields. A reused candidate passes the same identity checks, so an
existing tag carrying a plausible revision label cannot bypass qualification.
All three final image digests are exported only after verification, including a
second source-closure/checkout check. A lookup/TLS failure is not interpreted as
a missing image. Failed runtime identity is never repaired by rebuilding.

## Local validation and remaining execution

The 22 focused Python tests passed after the native window closed. They exercise real copied inputs and native
receipt hashes, file/path/type/executable-mode drift, ignored or untracked extra
inputs, recipe/ignore/lock changes, receipt tampering, layer order/count,
platform, every Config field including unknown fields, other-label mutations,
wrong qualified image/digest, rejection of the older publication for the new
image, pending publication, Transport Layer Security (TLS) lookup failure, reuse,
and the two-instruction promotion with verification before any mocked push.
The Docker build/push operations in these tests are controlled subprocess mocks.
Two additional focused manifest tests passed. A separate read-only check of the
actual local image and copied sources passed. At that earlier prepublication
checkpoint, both publication guards rejected the then-null reference with their
expected errors; that historical failure proof is not the current publication state. The
[guard verification receipt](evidence/runtime-guard-verification-176bcf-20261105.json)
records these outcomes and verifies the historical evidence bytes remain intact.

The [older local promotion receipt](evidence/runtime-label-promotion-20261104.json)
remains historical evidence for image `2b197eb80377` and revision label
`ff9c6df52dc14beb3aaf1bd2fefeeedc217ea0a5`; its local probe was not pushed or
deployed. The new `996e1ea5` publication and `c8b6db38` local probe are complete
at their recorded scopes.

The current 24-migration release manifest is refrozen from the unchanged original
deployment baseline to canonical SHA-256
`2e6512d2eef73bc130f928cfcc01b04bcb437529cb5ab4b90fa815a228dce6fa`.
[Isolated restore 41942455870](evidence/cloud-restore-20261105-41942455870.json)
at `2b869ac` passes all 13 actual Auth/Storage HTTP checks, all 24 migrations,
original certificate/hostname verification and both cleanup stages for that
manifest. It uses synthetic isolated data and does not exercise application
rendering, production rollout or proposal issuance.

Complete final application checks, any relevant revalidation after further
operations changes, final release-head promotion/readback, actual cutover/rollout
and hosted acceptance remain separate gates. Both cancelled release attempts
performed no cluster access, image publication or rollout. Additional
documentation or release-metadata commits do not require rebuilding the qualified
executable filesystem while its complete input closure remains identical.
