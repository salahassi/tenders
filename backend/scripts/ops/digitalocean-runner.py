#!/usr/bin/env python3
"""Prepare private, short-lived runner credentials without printing responses."""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

REGISTRY = "tenderdesk-a6093a76"
CLUSTER = "a6093a76-a2d6-47fd-8697-579d41ed316f"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def request(path):
    req = urllib.request.Request("https://api.digitalocean.com/v2/" + path,
        headers={"Authorization": "Bearer " + os.environ["DIGITALOCEAN_ACCESS_TOKEN"]})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=40) as response:
        data = response.read(1_048_577)
    if not data or len(data) > 1_048_576:
        raise ValueError("INVALID_CREDENTIAL_RESPONSE_SIZE")
    return data


def write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def docker_credentials(*, write_access):
    query = "?read_write=true&expiry_seconds=3600" if write_access else "?read_write=false"
    raw = request("registries/" + REGISTRY + "/docker-credentials" + query)
    value = json.loads(raw)
    if set(value) != {"auths"} or set(value["auths"]) != {"registry.digitalocean.com"}:
        raise ValueError("UNEXPECTED_REGISTRY_CREDENTIAL_HOST")
    auth = value["auths"]["registry.digitalocean.com"]
    if not isinstance(auth, dict) or not isinstance(auth.get("auth"), str) or not auth["auth"]:
        raise ValueError("INVALID_REGISTRY_CREDENTIAL_SHAPE")
    return raw


def main():
    os.umask(0o077)
    run, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    if not re.fullmatch(r"[0-9]{1,20}", run) or not re.fullmatch(r"[0-9]{1,6}", attempt):
        raise ValueError("INVALID_RUNNER_IDENTITY")
    directory = Path(os.environ["RUNNER_TEMP"]) / ("td-deploy-" + run + "-" + attempt)
    if sys.argv[1:] == ["--registry-pull-secret"]:
        # Permanent read-only credentials support future rescheduling. Never use
        # the runner's expiring push credential as an image-pull secret.
        raw = docker_credentials(write_access=False)
        import base64
        value = {"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/dockerconfigjson",
            "metadata": {"name": "tenderdesk-registry", "namespace": "tenderdesk-dev",
                         "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}},
            "data": {".dockerconfigjson": base64.b64encode(raw).decode()}}
        result = subprocess.run([os.environ["KUBECTL"], "--request-timeout=30s", "apply", "--server-side",
            "--field-manager=tenderdesk-deployment", "-f", "-"], input=json.dumps(value), text=True,
            capture_output=True, timeout=50)
        if result.returncode:
            raise ValueError("REGISTRY_PULL_SECRET_INSTALL_FAILED")
        print('{"runner":"read_only_registry_pull_secret_installed"}')
        return
    if sys.argv[1:]:
        raise ValueError("UNRECOGNIZED_RUNNER_MODE")
    directory.mkdir(mode=0o700, exist_ok=False)
    (directory / "docker").mkdir(mode=0o700)
    write(directory / "kubeconfig", request("kubernetes/clusters/" + CLUSTER + "/kubeconfig?expiry_seconds=3600"))
    write(directory / "docker/config.json", docker_credentials(write_access=True))
    kubectl = directory / "kubectl"
    for name in ("kubectl", "kubectl.sha256"):
        with urllib.request.urlopen("https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/" + name, timeout=60) as response:
            write(directory / name, response.read(80_000_001))
    expected = (directory / "kubectl.sha256").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(kubectl.read_bytes()).hexdigest() != expected:
        raise ValueError("KUBECTL_CHECKSUM_MISMATCH")
    kubectl.chmod(0o700)
    names = {"DOKS_WORKDIR": directory, "KUBECONFIG": directory / "kubeconfig", "KUBECTL": kubectl,
             "DOCKER_CONFIG": directory / "docker"}
    os.environ.update({key: str(value) for key, value in names.items()})
    spec = importlib.util.spec_from_file_location("runner_probe", Path(__file__).with_name("digitalocean-preflight.py"))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    probe.validate_cluster()
    config = json.loads(probe.kubectl(["config", "view", "--minify", "-o", "json"]))
    if len(config.get("users", [])) != 1 or set(config["users"][0]["user"]) != {"token"}:
        raise ValueError("TOKEN_ONLY_CLUSTER_IDENTITY_REQUIRED")
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        for key, value in names.items():
            stream.write(str(key) + "=" + str(value) + "\n")
    print('{"runner":"strict_cluster_tls_and_temporary_credentials_ready"}')


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"runner":"blocked","code":"CREDENTIAL_OR_CLIENT_PREPARATION_FAILED"}', flush=True)
        sys.exit(1)
