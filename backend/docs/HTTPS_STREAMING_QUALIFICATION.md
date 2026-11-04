# HTTPS streaming qualification

`backend/scripts/testing/https_api_streaming.py` exercises the actual pinned HTTPS image through TLS and the pinned Nginx gateway with a bounded synthetic upstream. It measures one complete response and one early cancellation for each of `identity`, `gzip`, and `zstd`. This is a local transport test, separate from application, Auth, SQL, hosted acceptance and concurrent-load qualification.

The default image is the exact HTTPS registry digest observed in inventory, `registry.digitalocean.com/tenderdesk-a6093a76/https@sha256:3a539c44f0907ba846f70ae6e97f477cccf2a34cc84cc492201d5d73e7cfa7ce`. The harness verifies that immutable repository digest. The separately built `70cfd48b…` image is an explicit alternative: that mode requires a canonical cached build of the unchanged `Dockerfile.https`, an identical resulting image ID and pinned-base layer ancestry. The two images are never treated as equivalent.

The repository's Caddyfile runs unchanged with `PUBLIC_HOST=localhost`. Caddy's local certificate authority operates offline; the client trusts its exact public root and verifies the `localhost` certificate hostname. No `-k`, unverified TLS context, external certificate request or public port is used. An isolated internal Docker network connects HTTPS to the gateway. Nginx uses only the existing fixture's loopback service/DNS substitutions. The repository production-target configuration itself pins one worker; the harness requires that exact directive and observes the master plus one worker. Both API routes must have the separately reviewed streaming setting.

The measured envelope is HTTPS 128MiB/300m and gateway 64MiB/200m, with no swap, a read-only filesystem, user 1000 and no capabilities. The separate read-only [inventory41928176279](evidence/digitalocean-https-capacity-20261104-41928176279.json) confirms these HTTPS limits on the Deployment and ready Pod; this is distinct from transport execution. The synthetic upstream uses a cached pinned Deno image with Node-compatible HTTP/crypto and its own 128MiB/1CPU limit. The bounded Python client is outside these service limits and is identified as such.

Each response contains 412,758,765 bytes of valid synthetic JSON. A deterministic AES-CTR/base64 generator varies the ASCII content across chunks, so compression is exercised without collapsing the large response into a tiny repeated block. A separate Python implementation computes the expected SHA-256 incrementally. The client requests each encoding explicitly, checks the actual `Content-Encoding`, reads at most 64KiB decoded chunks, pauses between reads, and checks the complete length and hash. It also checks the upstream's independently recorded sent-byte hash. No process materializes the full body. Encoded bodies may be larger than decoded content; reduction in size is not an acceptance condition.

Cancellation occurs after 2MiB decoded bytes. The receipt must show upstream closure before full emission and a stable sent-byte count afterward. Health checks run concurrently. Temporary-file observation includes directory entries and open, unlinked files held by the exact owned process IDs, with inode deduplication; it fails if observation is incomplete or the process set changes. Private mounts are created under `/workspace/work` and their actual in-container filesystem magic must equal Linux overlayfs `0x794c7630`. Default `/tmp` is tmpfs in this development environment and is rejected. Local certificate state uses the same overlay fixture; production persistent-volume durability is not measured. The disk budget is observed, not a simulated filesystem `ENOSPC` or hosted eviction. Cleanup verifies deletion of every nonce-owned container and network. Cleanup failure forces `passed: false`.

Run only in the scheduled native-test window, with all pinned images cached and Python `cryptography` and `zstandard` available:

```sh
python3 -m unittest discover -s backend/scripts/testing -p 'test_https_api_streaming.py'
python3 backend/scripts/testing/https_api_streaming.py \
  --output /workspace/output/https-api-streaming-r1/receipt.json
```

The receipt binds source hashes, image identity, actual binary hash/version, TLS checks, library versions, bytes, timings, memory events, temporary-file peaks and cleanup. It does not qualify HTTP/2 or HTTP/3, public certificate renewal, DigitalOcean LoadBalancer behavior, browser aggregate JSON parsing, arbitrary body sizes, concurrency or the 600-second proposal issuance objective.

The [retained diagnostics](evidence/https-api-streaming-diagnostics-20261104.json) preserve unsuccessful preparation attempts. The first disk-backed transfer run delivered all three complete bodies with matching hashes and no memory exhaustion, but failed an invalid shrink-only assertion before the zstd cancellation. That receipt remains failed. The subsequent final six-case run qualifies the narrow local transport scope below; the earlier failed receipt is unchanged.

## Final measured result

The [final receipt](evidence/https-api-streaming-20261104.json), SHA-256
`a10f52cf769a39d1204354796039e0bb6147a7a3dfdee5bae63a1a4621aace72`,
passed all six cases at source `5787071`, with exact source hashes retained.
It used the observed HTTPS registry image `3a539c44…`, the final gateway target
configuration `c1a25c41…`, its unchanged one-worker directive and the actual
overlay-backed fixture. The copied gateway/helper dependencies were independently
owned integration inputs; their exact hashes are in the receipt.

| Encoding | Decoded bytes | Encoded HTTP-body bytes | Complete-transfer seconds |
| --- | ---: | ---: | ---: |
| identity | 412,758,765 | 412,758,765 | 26.355 |
| gzip | 412,758,765 | 412,091,605 | 26.573 |
| zstd | 412,758,765 | 412,768,225 | 26.365 |

All decoded/source hashes matched. All three cancellations stopped the upstream
before completion and its sent-byte count remained stable. All162 health checks
passed. Maximum cgroup memory was25,833,472 bytes for HTTPS,13,045,760 for Nginx,
and96,387,072 for the synthetic helper, with zero OOM or swap. Private allocated
file peaks were36,864 bytes for HTTPS certificate/configuration state and4,096
bytes for Nginx's PID file; the exact process/FD census remained complete.
The three containers, network and private directory were removed and verified.

The transfer times include deliberate client pacing; they are not production
throughput or proposal-issuance SLO results. The test uses the release target's
one-worker gateway configuration; it does not claim that this new target was
already deployed. The separate resource inventory and this local execution do
not replace final hosted acceptance. No product configuration was changed by
this harness.
