# linux/amd64 manifest verified through Registry v2 on 2026-10-26.
FROM denoland/deno:alpine-2.9.8@sha256:3dc638972caa62978182228a5a575e0498ae45129aa1c3ee8548663652ef7ab6
WORKDIR /app/backend
ENV DENO_DIR=/deno-dir PORT=8080
COPY --chown=deno:deno backend/supabase/functions/ ./supabase/functions/
COPY --chown=deno:deno backend/scripts/runtime/ ./scripts/runtime/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export DENO_CERT=/run/secrets/proxy_ca; fi; \
    deno cache --frozen --config=supabase/functions/deno.json scripts/runtime/main.ts && chmod -R a+rX /deno-dir
USER deno
EXPOSE 8080
CMD ["run", "--cached-only", "--frozen", "--config=supabase/functions/deno.json", "--allow-env", "--allow-net", "--allow-sys", "--allow-read=/app,/deno-dir,/tmp", "--allow-write=/tmp", "scripts/runtime/main.ts"]
