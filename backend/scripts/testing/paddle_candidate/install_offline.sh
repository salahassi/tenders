#!/bin/sh
set -eu
python /build/verify_context.py /build
mkdir /provenance
cp /build/context-manifest.json /provenance/
cp -r /build/provenance/. /provenance/
# All dependencies are supplied as authenticated, hash-verified local archives.
# This RUN uses network=none; apt is forbidden from downloading missing bytes.
DEBIAN_FRONTEND=noninteractive dpkg --unpack /build/debs/*.deb
DEBIAN_FRONTEND=noninteractive dpkg --configure -a
python -m venv /opt/paddle
/opt/paddle/bin/python -m pip install --disable-pip-version-check --no-cache-dir --no-compile --no-index --find-links=/build/wheelhouse --require-hashes --only-binary=:all: -r /build/requirements.lock
cp /build/node /usr/local/bin/node
chmod 755 /usr/local/bin/node
cp -r /build/app /app
cp -r /build/models /models
cp -r /build/experiment /experiment
chmod -R a+rX /app /models /experiment /provenance
# User home is temporary storage, without changing the host or inherited HOME.
useradd --uid 1000 --no-create-home --home-dir /tmp/a06-home --shell /usr/sbin/nologin a06
/opt/paddle/bin/python /build/native_inventory.py
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
