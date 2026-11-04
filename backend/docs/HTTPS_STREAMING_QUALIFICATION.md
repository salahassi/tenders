# HTTPS streaming qualification

`backend/scripts/testing/https_api_streaming.py` exercises the actual pinned HTTPS image through TLS and the pinned Nginx gateway with a bounded synthetic upstream. It measures one complete response and one early cancellation for each of `identity`, `gzip`, and `zstd`. This is a local transport test, separate from application, Auth, SQL, hosted acceptance and concurrent-load qualification.

The default image is the exact HTTPS registry digest observed in inventory, `registry.digitalocean.com/tenderdesk-a6093a76/https@sha256:3a539c44f0907ba846f70ae6e97f477cccf2a34cc84cc492201d5d73e7cfa7ce`. The harness verifies that immutable repository digest. The separately built `70cfd48b…` image is an explicit alternative: that mode requires a canonical cached build of the unchanged `Dockerfile.https`, an identical resulting image ID and pinned-base layer ancestry. The two images are never treated as equivalent.

The repository's Caddyfile runs unchanged with `PUBLIC_HOST=localhost`. Caddy's local certificate authority operates offline; the client trusts its exact public root and verifies the `localhost` certificate hostname. No `-k`, unverified TLS context, external certificate request or public port is used. An isolated internal Docker network connects HTTPS to the gateway. Nginx uses the existing fixture's loopback service/DNS substitutions and one worker; both API routes must have the separately reviewed streaming setting.

The measured envelope is HTTPS 128MiB/300m and gateway 64MiB/200m, with no swap, a read-only filesystem, user 1000 and no capabilities. These HTTPS limits originate from the repository renderer until a separate hosted inventory confirms the actual deployment. The upstream has its own 128MiB/1CPU limit. The bounded Python client is outside these service limits and is identified as such.

Each response contains 412,758,765 bytes of valid synthetic JSON. A deterministic AES-CTR/base64 generator varies the ASCII content across chunks, so compression is exercised without collapsing the large response into a tiny repeated block. A separate Python implementation computes the expected SHA-256 incrementally. The client requests each encoding explicitly, checks the actual `Content-Encoding`, reads at most 64KiB decoded chunks, pauses between reads, and checks the complete length and hash. It also checks the upstream's independently recorded sent-byte hash. No process materializes the full body.

Cancellation occurs after 2MiB decoded bytes. The receipt must show upstream closure before full emission and a stable sent-byte count afterward. Health checks run concurrently. Temporary-file observation includes directory entries and open, unlinked files held by the exact owned process IDs, with inode deduplication; it fails if observation is incomplete or the process set changes. The disk budget is observed, not a simulated filesystem `ENOSPC` or hosted eviction. Cleanup verifies deletion of every nonce-owned container and network. Cleanup failure forces `passed: false`.

Run only in the scheduled native-test window, with all pinned images cached and Python `cryptography` and `zstandard` available:

```sh
python3 -m unittest discover -s backend/scripts/testing -p 'test_https_api_streaming.py'
python3 backend/scripts/testing/https_api_streaming.py \
  --output /workspace/output/https-api-streaming-r1/receipt.json
```

The receipt binds source hashes, image identity, actual binary hash/version, TLS checks, library versions, bytes, timings, memory events, temporary-file peaks and cleanup. It does not qualify HTTP/2 or HTTP/3, public certificate renewal, DigitalOcean LoadBalancer behavior, browser aggregate JSON parsing, arbitrary body sizes, concurrency or the 600-second proposal issuance objective.
