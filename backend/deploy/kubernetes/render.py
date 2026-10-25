#!/usr/bin/env python3
"""Render a private Supabase-compatible runtime and HTTPS frontend.

This renderer accepts public deployment coordinates and immutable image names.
Credentials belong in the separately managed tenderdesk-core and tenderdesk-runtime
Secrets. It never reads, accepts, or serializes administrator credentials.
"""
from __future__ import annotations

import argparse
import hashlib
from copy import deepcopy
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
AUTH_IMAGE = "docker.io/supabase/gotrue:v2.197.0@sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f"
REST_IMAGE = "docker.io/postgrest/postgrest:v14.18@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0"
STORAGE_IMAGE = "docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799"
NGINX_IMAGE = "docker.io/nginxinc/nginx-unprivileged:1.29.5-alpine@sha256:99e7cb7bee644b244b2b5e7bb737e972e54dbaa150cabc7ae0598731cdeb7ac8"
REQUIRED_CORE_KEYS = ("AUTH_DATABASE_URL", "STORAGE_DATABASE_URL", "POSTGREST_DATABASE_URL", "JWT_SECRET", "ANON_KEY", "SERVICE_KEY", "PGSSLCA")


def label(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?", value):
        raise ValueError("DEPLOYMENT_NAME_INVALID")
    return value


def image(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}", value):
        raise ValueError("DEPLOYMENT_IMAGE_DIGEST_REQUIRED")
    return value


def public_origin(value: str) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("DEPLOYMENT_HTTPS_ORIGIN_REQUIRED")
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.port not in (None, 443) or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("DEPLOYMENT_HTTPS_ORIGIN_REQUIRED")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", url.hostname) or ".." in url.hostname:
        raise ValueError("DEPLOYMENT_PUBLIC_HOST_INVALID")
    return "https://" + url.hostname, url.hostname


def env(name, value):
    return {"name": name, "value": str(value)}


def secret(name, key, secret_name="tenderdesk-core", optional=False):
    reference = {"name": secret_name, "key": key}
    if optional:
        reference["optional"] = True
    return {"name": name, "valueFrom": {"secretKeyRef": reference}}


def security():
    return {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
            "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
            "capabilities": {"drop": ["ALL"]}}


def metadata(name, namespace, component=None):
    return {"name": name, "namespace": namespace,
            "labels": {"app.kubernetes.io/part-of": "tenderdesk", "app.kubernetes.io/name": component or name}}


def namespace_object(namespace):
    return {"apiVersion": "v1", "kind": "Namespace", "metadata": {
        "name": label(namespace), "labels": {"app.kubernetes.io/part-of": "tenderdesk",
        "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted"}}}


def public_entrypoint(namespace="tenderdesk"):
    namespace = label(namespace)
    service = {"apiVersion": "v1", "kind": "Service", "metadata": metadata("public", namespace, "https"),
        "spec": {"type": "LoadBalancer", "externalTrafficPolicy": "Cluster", "selector": {"app.kubernetes.io/name": "https"},
        "ports": [{"name": "http", "port": 80, "targetPort": 8080}, {"name": "https", "port": 443, "targetPort": 8443}]}}
    service["metadata"]["annotations"] = {"service.beta.kubernetes.io/do-loadbalancer-name": "tenderdesk-app",
        "service.beta.kubernetes.io/do-loadbalancer-protocol": "tcp",
        "service.beta.kubernetes.io/do-loadbalancer-size-unit": "1"}
    return [namespace_object(namespace), service]


def build(config):
    namespace = label(config.get("namespace", "tenderdesk"))
    origin, host = public_origin(config["public_origin"])
    prefix = config.get("role_prefix", "tdp_app")
    if not re.fullmatch(r"tdp_[a-z0-9_]{1,24}", prefix):
        raise ValueError("DEPLOYMENT_ROLE_PREFIX_INVALID")
    runtime_image, frontend_image = image(config["runtime_image"]), image(config["frontend_image"])
    https_image = image(config.get("https_image", ""))
    public_key = config["publishable_key"]
    # Public anon JWT only; refuse a privileged role being embedded in JavaScript.
    import base64
    try:
        claims = json.loads(base64.urlsafe_b64decode(public_key.split(".")[1] + "==="))
    except Exception:
        raise ValueError("DEPLOYMENT_PUBLIC_KEY_INVALID") from None
    if claims.get("role") != prefix + "_anon":
        raise ValueError("DEPLOYMENT_PUBLIC_KEY_PRIVILEGED")
    if not isinstance(config.get("scheduler_enabled", False), bool) or not isinstance(config.get("native_workers_enabled", False), bool):
        raise ValueError("DEPLOYMENT_ACTIVATION_MUST_BE_BOOLEAN")
    storage_class = config.get("storage_class", "do-block-storage")
    label(storage_class)
    pull_secret = config.get("image_pull_secret")
    if pull_secret:
        label(pull_secret)
    result = public_entrypoint(namespace)
    result += [{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": metadata(name, namespace),
        "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": storage_class,
        "resources": {"requests": {"storage": size}}}} for name, size in [("private-objects", "20Gi"), ("https-state", "1Gi")]]
    configmaps = {
        "gateway-config": {"nginx.conf": (HERE / "gateway.conf").read_text().replace("__NAMESPACE__", namespace)},
        "https-config": {"Caddyfile": (HERE / "Caddyfile").read_text()},
        "frontend-config": {"runtime-config.js": "window.__TENDERDESK_CONFIG__ = " + json.dumps({"apiUrl": origin, "publishableKey": public_key, "appOrigin": origin}, separators=(",", ":")) + ";\n"},
    }
    for name, data in configmaps.items():
        result.append({"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata(name, namespace), "data": data})
    ca = {"name": "database-ca", "secret": {"secretName": "tenderdesk-core", "defaultMode": 0o444, "items": [{"key": "PGSSLCA", "path": "ca.crt"}]}}
    ca_mount = {"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True}

    def container(name, selected_image, values, port, health, memory_request, memory_limit, cpu="500m", mounts=None):
        return {"name": name, "image": selected_image, "imagePullPolicy": "IfNotPresent", "securityContext": security(),
            "ports": [{"name": "http", "containerPort": port}], "env": values,
            "startupProbe": {"httpGet": {"path": health, "port": port}, "periodSeconds": 3, "timeoutSeconds": 3, "failureThreshold": 100},
            "readinessProbe": {"httpGet": {"path": health, "port": port}, "periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 3},
            "livenessProbe": {"httpGet": {"path": health, "port": port}, "periodSeconds": 20, "timeoutSeconds": 5, "failureThreshold": 5},
            "resources": {"requests": {"cpu": "25m", "memory": memory_request}, "limits": {"cpu": cpu, "memory": memory_limit}},
            "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}, *(mounts or [])]}

    def deployment(name, pod_container, service_port=None, volumes=None, recreate=False, grace=30):
        spec = {"automountServiceAccountToken": False, "terminationGracePeriodSeconds": grace,
            "nodeSelector": {"kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux"},
            "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "fsGroupChangePolicy": "OnRootMismatch", "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [pod_container], "volumes": [{"name": "tmp", "emptyDir": {"sizeLimit": "64Mi"}}, *(volumes or [])]}
        if pull_secret:
            spec["imagePullSecrets"] = [{"name": pull_secret}]
        pod_metadata = {"labels": metadata(name, namespace)["labels"]}
        config_name = {"frontend": "frontend-config", "gateway": "gateway-config", "https": "https-config"}.get(name)
        if config_name:
            pod_metadata["annotations"] = {"checksum/public-config": hashlib.sha256(json.dumps(configmaps[config_name], sort_keys=True).encode()).hexdigest()}
        result.append({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": metadata(name, namespace),
            "spec": {"replicas": 1, "revisionHistoryLimit": 2,
                "strategy": {"type": "Recreate"} if recreate else {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1}},
                "selector": {"matchLabels": {"app.kubernetes.io/name": name}},
                "template": {"metadata": pod_metadata, "spec": spec}}})
        if service_port is not None:
            result.append({"apiVersion": "v1", "kind": "Service", "metadata": metadata(name, namespace),
                "spec": {"type": "ClusterIP", "selector": {"app.kubernetes.io/name": name},
                    "ports": [{"name": "http", "port": service_port, "targetPort": service_port}]}})

    auth_env = [secret("GOTRUE_DB_DATABASE_URL", "AUTH_DATABASE_URL"), secret("GOTRUE_JWT_SECRET", "JWT_SECRET"),
        env("GOTRUE_API_HOST", "0.0.0.0"), env("GOTRUE_API_PORT", 9999), env("API_EXTERNAL_URL", origin),
        env("GOTRUE_SITE_URL", origin + "/"), env("GOTRUE_URI_ALLOW_LIST", origin + "/**"), env("GOTRUE_DB_DRIVER", "postgres"),
        env("GOTRUE_DB_NAMESPACE", "auth"), env("GOTRUE_DB_MAX_POOL_SIZE", 3), env("GOTRUE_DB_MAX_IDLE_POOL_SIZE", 1),
        env("GOTRUE_JWT_ADMIN_ROLES", prefix + "_service"), env("GOTRUE_JWT_DEFAULT_GROUP_NAME", prefix + "_authenticated"),
        env("GOTRUE_JWT_AUD", "authenticated"), env("GOTRUE_JWT_EXP", 900), env("GOTRUE_JWT_ISSUER", origin + "/auth/v1"),
        env("GOTRUE_DISABLE_SIGNUP", "false"),
        env("GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED", "true"),
        env("GOTRUE_HOOK_BEFORE_USER_CREATED_URI", "pg-functions://postgres/app_private/before_user_created"), env("GOTRUE_EXTERNAL_EMAIL_ENABLED", "true"), env("GOTRUE_EXTERNAL_PHONE_ENABLED", "false"),
        env("GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED", "false"), env("GOTRUE_MAILER_AUTOCONFIRM", "false"),
        *[env("GOTRUE_MAILER_URLPATHS_" + action, "/auth/v1/verify") for action in ("INVITE", "CONFIRMATION", "RECOVERY", "EMAIL_CHANGE")],
        *[secret(target, key, "tenderdesk-runtime", optional=True) for target, key in [
            ("GOTRUE_SMTP_HOST", "APP_SMTP_HOST"), ("GOTRUE_SMTP_PORT", "APP_SMTP_PORT"),
            ("GOTRUE_SMTP_USER", "APP_SMTP_USER"), ("GOTRUE_SMTP_PASS", "APP_SMTP_PASSWORD"),
            ("GOTRUE_SMTP_ADMIN_EMAIL", "AUTH_SMTP_ADMIN_EMAIL"), ("GOTRUE_SMTP_SENDER_NAME", "AUTH_SMTP_SENDER_NAME")]],
        env("GOTRUE_LOG_LEVEL", "error")]
    auth = container("auth", AUTH_IMAGE, auth_env, 9999, "/health", "64Mi", "192Mi", mounts=[ca_mount])
    deployment("auth", auth, 9999, [ca])
    rest = container("rest", REST_IMAGE, [secret("PGRST_DB_URI", "POSTGREST_DATABASE_URL"), secret("PGRST_JWT_SECRET", "JWT_SECRET"),
        env("PGRST_DB_SCHEMAS", "public"), env("PGRST_DB_EXTRA_SEARCH_PATH", "public,extensions"),
        env("PGRST_DB_ANON_ROLE", prefix + "_anon"), env("PGRST_DB_POOL", 5), env("PGRST_DB_MAX_ROWS", 1000),
        env("PGRST_SERVER_HOST", "0.0.0.0"), env("PGRST_SERVER_PORT", 3000), env("PGRST_ADMIN_SERVER_HOST", "0.0.0.0"),
        env("PGRST_ADMIN_SERVER_PORT", 3001), env("PGRST_LOG_LEVEL", "error")], 3000, "/", "32Mi", "128Mi", mounts=[ca_mount])
    # Health is served on the separate PostgREST admin listener.
    for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
        rest[probe]["httpGet"] = {"path": "/ready", "port": 3001}
    rest["ports"].append({"name": "admin", "containerPort": 3001})
    deployment("rest", rest, 3000, [ca])
    storage_env = [secret("DATABASE_URL", "STORAGE_DATABASE_URL"), secret("DATABASE_POOL_URL", "POSTGREST_DATABASE_URL"),
        secret("DATABASE_SSL_ROOT_CERT", "PGSSLCA"), secret("AUTH_JWT_SECRET", "JWT_SECRET"), secret("ANON_KEY", "ANON_KEY"), secret("SERVICE_KEY", "SERVICE_KEY"),
        env("DB_ANON_ROLE", prefix + "_anon"), env("DB_AUTHENTICATED_ROLE", prefix + "_authenticated"), env("DB_SERVICE_ROLE", prefix + "_service"),
        env("DB_SUPER_USER", prefix + "_storageadmin"), env("DB_INSTALL_ROLES", "false"), env("DB_ALLOW_MIGRATION_REFRESH", "false"),
        env("DATABASE_SEARCH_PATH", "storage,public,extensions"), env("DATABASE_MAX_CONNECTIONS", 5), env("DATABASE_CONNECTION_TIMEOUT", 15000),
        env("DATABASE_STATEMENT_TIMEOUT", 15000), env("POSTGREST_URL", "http://rest:3000"), env("SERVER_HOST", "0.0.0.0"), env("SERVER_PORT", 5000),
        env("STORAGE_PUBLIC_URL", origin + "/storage/v1"), env("STORAGE_BACKEND", "file"), env("FILE_STORAGE_BACKEND_PATH", "/var/lib/storage"),
        env("GLOBAL_S3_BUCKET", "tenderdesk"), env("TENANT_ID", "tenderdesk"), env("REGION", "sfo3"), env("FILE_SIZE_LIMIT", 10485760),
        env("IMAGE_TRANSFORMATION_ENABLED", "false"), env("S3_PROTOCOL_ENABLED", "false"), env("PG_QUEUE_ENABLE", "false"),
        env("LOG_LEVEL", "error"), env("LOGFLARE_ENABLED", "false"), env("TRACING_ENABLED", "false"), env("OTEL_METRICS_ENABLED", "false"), env("NODE_OPTIONS", "--max-old-space-size=256")]
    storage = container("storage", STORAGE_IMAGE, storage_env, 5000, "/status", "128Mi", "384Mi", mounts=[ca_mount, {"name": "objects", "mountPath": "/var/lib/storage"}])
    deployment("storage", storage, 5000, [ca, {"name": "objects", "persistentVolumeClaim": {"claimName": "private-objects"}}], recreate=True)
    runtime_env = [env("PORT", 8080), env("SUPABASE_URL", "http://gateway:8081"),
        secret("SUPABASE_ANON_KEY", "ANON_KEY"), secret("SUPABASE_SERVICE_ROLE_KEY", "SERVICE_KEY"),
        env("APP_ALLOWED_ORIGINS", origin), env("APP_PUBLIC_API_URL", origin), env("APP_PUBLIC_URL", origin + "/"), env("APP_WORKER_URL", "http://worker:8080/functions/v1/worker"),
        env("APP_SCHEDULER_ENABLED", str(config.get("scheduler_enabled", False)).lower())]
    for name, request, limit, cpu in [("api", "128Mi", "384Mi", "700m"), ("worker", "192Mi", "640Mi", "1000m"), ("source-browser", "64Mi", "256Mi", "500m"), ("scheduler", "48Mi", "192Mi", "300m")]:
        service = container(name, runtime_image, [*runtime_env, env("APP_RUNTIME_SERVICE", name)], 8080, "/readyz", request, limit, cpu)
        service["envFrom"] = [{"secretRef": {"name": "tenderdesk-runtime"}}]
        deployment(name, service, 8080, grace=240)
    frontend = container("frontend", frontend_image, [], 8080, "/healthz", "16Mi", "64Mi", "200m", mounts=[{"name": "public-config", "mountPath": "/usr/share/nginx/html/runtime-config.js", "subPath": "runtime-config.js", "readOnly": True}])
    deployment("frontend", frontend, 8080, [{"name": "public-config", "configMap": {"name": "frontend-config", "defaultMode": 0o444}}])
    gateway = container("gateway", NGINX_IMAGE, [], 8080, "/healthz", "16Mi", "64Mi", "200m", mounts=[{"name": "nginx-config", "mountPath": "/etc/nginx/nginx.conf", "subPath": "nginx.conf", "readOnly": True}])
    gateway["command"] = ["nginx", "-g", "daemon off;"]
    gateway["ports"].append({"name": "internal", "containerPort": 8081})
    deployment("gateway", gateway, None, [{"name": "nginx-config", "configMap": {"name": "gateway-config", "defaultMode": 0o444}}])
    result.append({"apiVersion": "v1", "kind": "Service", "metadata": metadata("gateway", namespace), "spec": {"selector": {"app.kubernetes.io/name": "gateway"}, "ports": [{"name": "public", "port": 8080, "targetPort": 8080}, {"name": "internal", "port": 8081, "targetPort": 8081}]}})
    caddy = container("https", https_image, [env("PUBLIC_HOST", host), env("XDG_DATA_HOME", "/data"), env("XDG_CONFIG_HOME", "/config")], 8082, "/healthz", "32Mi", "128Mi", "300m",
        mounts=[{"name": "https-config", "mountPath": "/etc/caddy/Caddyfile", "subPath": "Caddyfile", "readOnly": True}, {"name": "https-state", "mountPath": "/data"}, {"name": "https-config-state", "mountPath": "/config"}])
    caddy["command"] = ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
    caddy["ports"] += [{"name": "http-acme", "containerPort": 8080}, {"name": "https", "containerPort": 8443}]
    deployment("https", caddy, None, [{"name": "https-config", "configMap": {"name": "https-config", "defaultMode": 0o444}}, {"name": "https-state", "persistentVolumeClaim": {"claimName": "https-state"}}, {"name": "https-config-state", "emptyDir": {"sizeLimit": "16Mi"}}], recreate=True)
    # Internal services accept only same-namespace pods. In particular a public
    # LoadBalancer can target only HTTPS, never source-browser or worker.
    result += [{"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": metadata("internal-services", namespace),
        "spec": {"podSelector": {"matchExpressions": [{"key": "app.kubernetes.io/name", "operator": "NotIn", "values": ["https"]}]},
        "policyTypes": ["Ingress"], "ingress": [{"from": [{"podSelector": {}}]}]}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": metadata("https-ingress", namespace),
        "spec": {"podSelector": {"matchLabels": {"app.kubernetes.io/name": "https"}}, "policyTypes": ["Ingress"],
        "ingress": [{"ports": [{"protocol": "TCP", "port": 8080}, {"protocol": "TCP", "port": 8443}, {"protocol": "TCP", "port": 8082}]}]}}]
    for name, config_key, request, limit in [("browser", "browser_image", "256Mi", "768Mi"), ("ocr", "ocr_image", "256Mi", "768Mi")]:
        if not config.get(config_key):
            if config.get("native_workers_enabled"):
                raise ValueError("DEPLOYMENT_NATIVE_IMAGE_REQUIRED")
            continue
        native = {"name": name, "image": image(config[config_key]), "imagePullPolicy": "IfNotPresent", "securityContext": security(),
            "env": [env("APP_NATIVE_WORKER_URL", "http://source-browser:8080/functions/v1/source-browser"), secret("APP_NATIVE_WORKER_SECRET", "APP_NATIVE_WORKER_SECRET", "tenderdesk-runtime")],
            "resources": {"requests": {"cpu": "100m", "memory": request}, "limits": {"cpu": "1000m", "memory": limit}},
            "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}, {"name": "shm", "mountPath": "/dev/shm"}]}
        pod = {"restartPolicy": "Never", "automountServiceAccountToken": False, "terminationGracePeriodSeconds": 30,
            "nodeSelector": {"kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux"},
            "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "fsGroupChangePolicy": "OnRootMismatch", "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [native], "volumes": [{"name": "tmp", "emptyDir": {"sizeLimit": "1Gi"}}, {"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": "128Mi"}}]}
        if pull_secret:
            pod["imagePullSecrets"] = [{"name": pull_secret}]
        result.append({"apiVersion": "batch/v1", "kind": "CronJob", "metadata": metadata("native-" + name, namespace),
            "spec": {"schedule": "*/10 * * * *", "suspend": not config.get("native_workers_enabled", False), "concurrencyPolicy": "Forbid",
            "successfulJobsHistoryLimit": 1, "failedJobsHistoryLimit": 1, "startingDeadlineSeconds": 90,
            "jobTemplate": {"spec": {"backoffLimit": 0, "activeDeadlineSeconds": 600, "ttlSecondsAfterFinished": 3600,
                "template": {"metadata": {"labels": metadata("native-" + name, namespace)["labels"]}, "spec": pod}}}}})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--namespace", default="tenderdesk")
    parser.add_argument("--entrypoint-only", action="store_true")
    args = parser.parse_args()
    if args.entrypoint_only:
        result = public_entrypoint(args.namespace)
    else:
        if args.config is None:
            parser.error("--config is required")
        result = build(json.loads(args.config.read_text()))
    print(json.dumps({"apiVersion": "v1", "kind": "List", "items": result}, separators=(",", ":")))


if __name__ == "__main__":
    main()
