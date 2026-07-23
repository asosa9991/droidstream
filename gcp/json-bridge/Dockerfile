FROM python:3.12-slim

# adb drives the ephemeral device; the docker CLI is needed for `docker port`
# to resolve a session's internal adb port (the control plane's own public
# API intentionally does not expose it -- see gcp/README.md).
#
# Install docker-ce-cli from Docker's own apt repo, not Debian's docker.io
# package -- the same fix control-plane/Dockerfile needed: Debian's bundled
# client is old enough that a modern Docker Engine daemon refuses it
# outright (API version too old).
RUN apt-get update && apt-get install -y --no-install-recommends \
      android-sdk-platform-tools-common \
      adb \
      ca-certificates \
      curl \
      gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Pillow: filmstrip mode (?full=1) only. Single-shot /api/json works without it.
RUN pip install --no-cache-dir Pillow

WORKDIR /app
COPY bridge.py ./bridge.py
COPY assets ./assets

EXPOSE 8600
CMD ["sh", "-c", "adb start-server && python3 bridge.py"]
