"""Private, disposable Auth/PostgREST/Storage bootstrap Job.

Image tags follow the official Supabase docker-compose retrieved 2026-10-25.
Each linux/amd64 manifest and its configuration architecture were verified using
Docker Registry v2 over HTTPS. Pinning a platform manifest also prevents tag drift.
Sources:
  https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml
  https://github.com/supabase/auth/blob/v2.197.0/internal/conf/configuration.go
  https://github.com/supabase/storage/blob/v1.81.0/src/config.ts
  https://github.com/supabase/storage/blob/v1.81.0/src/internal/database/postgres/ssl.ts

Only a synthetic, isolated bootstrap database belongs behind these services.
The filesystem backend is disposable; this is not production Storage.
"""
from __future__ import annotations

from copy import deepcopy
import re


AUTH_IMAGE = "docker.io/supabase/gotrue:v2.197.0@sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f"
REST_IMAGE = "docker.io/postgrest/postgrest:v14.18@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0"
STORAGE_IMAGE = "docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799"
PROBE_IMAGE = "docker.io/library/python:3.13-alpine@sha256:5dcbe6043e931f65945060c7a991d55035191d7dfc52c8bed14468e95b8f7b9a"

REQUIRED_SECRET_KEYS = (
    "ROLE_PREFIX", "BOOTSTRAP_DATABASE", "AUTH_DATABASE_URL", "STORAGE_DATABASE_URL",
    "POSTGREST_DATABASE_URL", "PGSSLCA", "JWT_SECRET", "ANON_KEY", "SERVICE_KEY",
)
SIDECAR_NAMES = ("auth", "rest", "storage")


def _name(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?", value):
        raise ValueError("Expected a Kubernetes DNS label")
    return value


def _literal(name: str, value: str) -> dict:
    return {"name": name, "value": value}


def _secret(name: str, key: str, secret_name: str) -> dict:
    return {"name": name, "valueFrom": {"secretKeyRef": {"name": secret_name, "key": key}}}


def _security() -> dict:
    return {
        "runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
        "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
        "capabilities": {"drop": ["ALL"]},
    }


def _sidecar(name: str, image: str, env: list, path: str, port: int,
             memory_request: str, memory_limit: str, cpu_limit: str) -> dict:
    return {
        "name": name, "image": image, "imagePullPolicy": "IfNotPresent",
        "restartPolicy": "Always", "securityContext": _security(), "env": env,
        # Kubelet starts the next native sidecar only after this succeeds.
        "startupProbe": {
            "httpGet": {"path": path, "port": port, "scheme": "HTTP"},
            "timeoutSeconds": 3, "periodSeconds": 3, "failureThreshold": 60,
        },
        "resources": {"requests": {"cpu": "50m", "memory": memory_request},
                      "limits": {"cpu": cpu_limit, "memory": memory_limit}},
        "volumeMounts": [
            {"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True},
            {"name": "tmp-" + name, "mountPath": "/tmp"},
        ],
    }


def build_bootstrap_job(namespace: str, labels: dict[str, str],
                        secret_name: str = "bootstrap-secrets",
                        configmap_name: str = "bootstrap-code",
                        job_name: str = "compatible-services") -> dict:
    """Return a Job using references only; never accept or embed credentials.

    Orchestrator order: setup.sql Job, this Job, wait for the three named init
    containers' ``started`` flags, post-migrations.sql Job, HTTP acceptance.
    The main acceptance script must wait for the post-migration fixture marker.
    Main-container termination stops native sidecars automatically.

    Database URLs must use the validated private DNS endpoint and
    sslmode=verify-full&sslrootcert=/run/db-ca/ca.crt. PGSSLCA holds PEM content.
    The roles are ROLE_PREFIX plus _authadmin/_storageadmin/_authenticator,
    _anon/_authenticated/_service. Storage owns its migrations; the separate
    authenticator pool uses scoped SET ROLE instead of inheriting owner rights.
    """
    for value in (namespace, secret_name, configmap_name, job_name):
        _name(value)
    if not isinstance(labels, dict) or not labels or not all(
        isinstance(k, str) and isinstance(v, str) and k and len(k) <= 253 and len(v) <= 63
        for k, v in labels.items()
    ):
        raise ValueError("Explicit ownership labels are required")
    labels = deepcopy(labels)
    secret = lambda name, key=None: _secret(name, key or name, secret_name)
    auth_env = [
        secret("ROLE_PREFIX"), secret("GOTRUE_DB_DATABASE_URL", "AUTH_DATABASE_URL"),
        secret("GOTRUE_JWT_SECRET", "JWT_SECRET"),
        _literal("GOTRUE_API_HOST", "0.0.0.0"), _literal("GOTRUE_API_PORT", "9999"),
        _literal("API_EXTERNAL_URL", "http://127.0.0.1:9999/auth/v1"),
        _literal("GOTRUE_SITE_URL", "http://127.0.0.1:9999"),
        _literal("GOTRUE_URI_ALLOW_LIST", ""),
        _literal("GOTRUE_DB_DRIVER", "postgres"), _literal("GOTRUE_DB_NAMESPACE", "auth"),
        _literal("GOTRUE_DB_MAX_POOL_SIZE", "3"), _literal("GOTRUE_DB_MAX_IDLE_POOL_SIZE", "1"),
        _literal("GOTRUE_JWT_ADMIN_ROLES", "$(ROLE_PREFIX)_service"),
        _literal("GOTRUE_JWT_DEFAULT_GROUP_NAME", "$(ROLE_PREFIX)_authenticated"),
        _literal("GOTRUE_JWT_AUD", "authenticated"), _literal("GOTRUE_JWT_EXP", "900"),
        _literal("GOTRUE_JWT_ISSUER", "http://127.0.0.1:9999/auth/v1"),
        _literal("GOTRUE_DISABLE_SIGNUP", "true"),
        _literal("GOTRUE_EXTERNAL_EMAIL_ENABLED", "true"),
        _literal("GOTRUE_EXTERNAL_PHONE_ENABLED", "false"),
        _literal("GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED", "false"),
        _literal("GOTRUE_MAILER_AUTOCONFIRM", "false"),
        _literal("GOTRUE_LOG_LEVEL", "error"),
    ]
    rest_env = [
        secret("ROLE_PREFIX"), secret("PGRST_DB_URI", "POSTGREST_DATABASE_URL"),
        secret("PGRST_JWT_SECRET", "JWT_SECRET"),
        _literal("PGRST_DB_SCHEMAS", "public"),
        _literal("PGRST_DB_EXTRA_SEARCH_PATH", "public,extensions"),
        _literal("PGRST_DB_ANON_ROLE", "$(ROLE_PREFIX)_anon"),
        _literal("PGRST_DB_POOL", "3"), _literal("PGRST_DB_MAX_ROWS", "100"),
        _literal("PGRST_SERVER_HOST", "0.0.0.0"), _literal("PGRST_SERVER_PORT", "3000"),
        _literal("PGRST_ADMIN_SERVER_HOST", "0.0.0.0"),
        _literal("PGRST_ADMIN_SERVER_PORT", "3001"),
        _literal("PGRST_LOG_LEVEL", "error"),
    ]
    storage_env = [
        secret("ROLE_PREFIX"), secret("DATABASE_URL", "STORAGE_DATABASE_URL"),
        secret("DATABASE_POOL_URL", "POSTGREST_DATABASE_URL"),
        secret("DATABASE_SSL_ROOT_CERT", "PGSSLCA"),
        secret("AUTH_JWT_SECRET", "JWT_SECRET"), secret("ANON_KEY"), secret("SERVICE_KEY"),
        _literal("DB_ANON_ROLE", "$(ROLE_PREFIX)_anon"),
        _literal("DB_AUTHENTICATED_ROLE", "$(ROLE_PREFIX)_authenticated"),
        _literal("DB_SERVICE_ROLE", "$(ROLE_PREFIX)_service"),
        _literal("DB_SUPER_USER", "$(ROLE_PREFIX)_storageadmin"),
        _literal("DB_INSTALL_ROLES", "false"),
        _literal("DB_ALLOW_MIGRATION_REFRESH", "false"),
        _literal("DATABASE_SEARCH_PATH", "storage,public,extensions"),
        _literal("DATABASE_MAX_CONNECTIONS", "3"),
        _literal("DATABASE_CONNECTION_TIMEOUT", "15000"),
        _literal("DATABASE_STATEMENT_TIMEOUT", "15000"),
        _literal("POSTGREST_URL", "http://127.0.0.1:3000"),
        _literal("SERVER_HOST", "0.0.0.0"), _literal("SERVER_PORT", "5000"),
        _literal("STORAGE_PUBLIC_URL", "http://127.0.0.1:5000"),
        _literal("STORAGE_BACKEND", "file"),
        _literal("FILE_STORAGE_BACKEND_PATH", "/var/lib/storage"),
        _literal("GLOBAL_S3_BUCKET", "bootstrap"), _literal("TENANT_ID", "bootstrap"),
        _literal("REGION", "local"), _literal("FILE_SIZE_LIMIT", "1048576"),
        _literal("IMAGE_TRANSFORMATION_ENABLED", "false"),
        _literal("S3_PROTOCOL_ENABLED", "false"), _literal("PG_QUEUE_ENABLE", "false"),
        _literal("LOG_LEVEL", "error"), _literal("LOGFLARE_ENABLED", "false"),
        _literal("TRACING_ENABLED", "false"), _literal("OTEL_METRICS_ENABLED", "false"),
        _literal("NODE_OPTIONS", "--max-old-space-size=256"),
    ]
    auth = _sidecar("auth", AUTH_IMAGE, auth_env, "/health", 9999, "64Mi", "192Mi", "300m")
    rest = _sidecar("rest", REST_IMAGE, rest_env, "/ready", 3001, "32Mi", "128Mi", "250m")
    storage = _sidecar("storage", STORAGE_IMAGE, storage_env, "/status", 5000, "128Mi", "384Mi", "500m")
    storage["volumeMounts"].append({"name": "bootstrap-objects", "mountPath": "/var/lib/storage"})
    acceptance = {
        "name": "acceptance", "image": PROBE_IMAGE, "imagePullPolicy": "IfNotPresent",
        "command": ["python3", "-B", "/opt/bootstrap/acceptance.py"],
        "env": [
            secret("ROLE_PREFIX"), secret("BOOTSTRAP_DATABASE"),
            secret("JWT_SECRET"), secret("ANON_KEY"), secret("SERVICE_KEY"),
            _literal("AUTH_URL", "http://127.0.0.1:9999"),
            _literal("REST_URL", "http://127.0.0.1:3000"),
            _literal("STORAGE_URL", "http://127.0.0.1:5000"),
            _literal("PYTHONDONTWRITEBYTECODE", "1"),
            _literal("PYTHONUNBUFFERED", "1"),
        ],
        "securityContext": _security(),
        "resources": {"requests": {"cpu": "25m", "memory": "32Mi"},
                      "limits": {"cpu": "250m", "memory": "128Mi"}},
        "volumeMounts": [{"name": "bootstrap-code", "mountPath": "/opt/bootstrap", "readOnly": True},
                         {"name": "tmp-acceptance", "mountPath": "/tmp"}],
    }
    return {
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": {"name": job_name, "namespace": namespace, "labels": labels},
        "spec": {
            # Leave credential ownership alive while the orchestrator removes
            # isolated DB objects, even after a service/acceptance failure.
            "backoffLimit": 0, "activeDeadlineSeconds": 900, "ttlSecondsAfterFinished": 900,
            "template": {
                "metadata": {"labels": deepcopy(labels)},
                "spec": {
                    "restartPolicy": "Never", "automountServiceAccountToken": False,
                    "nodeSelector": {"kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux"},
                    "terminationGracePeriodSeconds": 15,
                    "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
                                        "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
                    "initContainers": [auth, rest, storage], "containers": [acceptance],
                    "volumes": [
                        {"name": "database-ca", "secret": {"secretName": secret_name, "defaultMode": 0o444,
                            "items": [{"key": "PGSSLCA", "path": "ca.crt"}]}},
                        {"name": "bootstrap-code", "configMap": {"name": configmap_name, "defaultMode": 0o444}},
                        {"name": "bootstrap-objects", "emptyDir": {"sizeLimit": "16Mi"}},
                        *[{"name": "tmp-" + name, "emptyDir": {"sizeLimit": "16Mi"}}
                          for name in (*SIDECAR_NAMES, "acceptance")],
                    ],
                },
            },
        },
    }
