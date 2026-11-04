# Runtime qualification and revision-label promotion

The release must use the filesystem and runtime configuration actually exercised
in the retained native receipts. A matching Git revision label alone does not
establish that identity. `runtime-qualification.py` binds the qualified local
image `sha256:89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe`;
`proposal-delivery-images.py` now requires this binding for both new and reused
runtime candidates. Frontend and OCR image preparation retains its existing
source-build contract.

## Recorded local proof

[The frozen qualification receipt](evidence/runtime-qualification-89af-20261104.json)
records the actual image inspection, ordered 17 RootFS diff IDs, complete Docker
`Config` except its separately recorded labels, platform, and all 146 entries
in `/app` obtained as a tar inventory from a never-started container. The exact
130 regular files in the five Dockerfile COPY roots match the current checkout
byte for byte. The recorded pinned Deno base has ten ordered layers, all an
exact prefix of the qualified image. No image was started, rebuilt, pushed or
modified during this observation; the temporary inspection container was removed.

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
they are not claimed as Docker COPY inputs. The original Dockerfile is not
embedded in image89af, so its recipe/hash binding is retrospective, supported by
the image history, runtime Config, pinned-base layer prefix and exact copied
bytes. This is not a historical Dockerfile byte attestation or a claim that a
source rebuild would reproduce the image.

The receipt hashes and checks the unchanged evidence below, including each
recorded image identity and copied-source hashes:

- [Actual API download and admission proof](evidence/native-api-owned-snapshot-steady-20261104.json): actual handler/native verifier with migrated API-admitted synthetic input and emulated Auth/RPC/Storage.
- [Reviewed DOCX completion proof](evidence/native-reviewed-docx-handler-20261104.json): actual handler/native verifier with the saved ordinary request and a synthetic `ordinary-2` server pin/Auth/RPC/Storage.
- [Bounded batch upstream proof](evidence/native-api-batch-capacity-20261104.json): actual-image handler and transport with isolated real PostgreSQL/PostgREST, synthetic Auth and the recorded loopback adapter.

Their original resource envelopes, outcomes and limitations remain authoritative.
This provenance work supplies no additional native execution, live provider,
model-quality, hosted acceptance, production service-level or desktop Word proof.

## Exact publication and promotion sequence

The [publication binding](evidence/runtime-qualified-publication-20261104.json)
now records the actual immutable registry reference
`registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:67fc1be0f574ea9b65e40408da436c3173fb4f332bb7729fe8da75e1ccaa4d28`.
The existing image was published unchanged, pulled back by digest, and verified
as exactly image89af with identical layers and Config. Temporary push credentials
were removed. No application deployment or native rerun occurred. The original
null-reference preparation state failed closed; a local image ID was never
substituted for a registry manifest digest.

With that binding recorded, the release verifies the current checkout's
complete input closure, then pulls the exact qualified digest and requires its
original image ID, layers, platform, Config and labels. A missing candidate is
promoted using an otherwise empty temporary context containing exactly:

```dockerfile
FROM registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:<observed-qualified-manifest>
LABEL org.opencontainers.image.revision=<release-checkout-revision>
```

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

The 22 focused Python tests passed. They exercise real copied inputs and native
receipt hashes, file/path/type/executable-mode drift, ignored or untracked extra
inputs, recipe/ignore/lock changes, receipt tampering, layer order/count,
platform, every Config field including unknown fields, other-label mutations,
wrong qualified image/digest, pending publication, TLS lookup failure, reuse,
and the two-instruction promotion with verification before any mocked push.
The Docker build/push operations in these tests are controlled subprocess mocks.

Actual registry publication and an actual local label-only promotion have passed.
The [promotion receipt](evidence/runtime-label-promotion-20261104.json) records
image `2b197eb80377` for revision label `ff9c6df52dc14beb3aaf1bd2fefeeedc217ea0a5`,
with identical ordered layers and runtime Config and no other label change.
The promoted local probe was not pushed or deployed. Final release promotion,
manifest, cloud restore/cutover and hosted acceptance remain separate gates.
Additional documentation or release metadata commits do not require rebuilding
the qualified executable filesystem.
