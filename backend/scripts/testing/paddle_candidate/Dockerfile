FROM docker.io/library/python:3.11-slim-bookworm@sha256:061c190f3d5815b341a18dfe8a45771f8ba68c15a607ea56997fde3009ac4eec
# One filesystem layer avoids repeated multi-GiB vfs copies. Inputs are read-only,
# hash-checked and available only in this offline build step.
RUN --mount=type=bind,target=/build,ro /bin/sh /build/install_offline.sh
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
WORKDIR /app/backend
ENTRYPOINT ["/usr/local/bin/node", "--experimental-transform-types", "/experiment/run_parent.mjs"]
