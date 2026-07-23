FROM node:22-bookworm-slim

# adb drives the device; the docker CLI starts sibling device containers.
#
# Debian's `docker.io` package ships a very old client (API 1.41) that
# newer Docker Engine daemons refuse outright ("client version too old,
# minimum supported API version is 1.44") -- this bit us talking to a
# stock Ubuntu 24.04 host's docker.io-installed engine (29.x). Install the
# CLI from Docker's own apt repo instead so it stays current with the
# daemons it's actually likely to be pointed at.
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

WORKDIR /app

COPY control-plane/package.json ./control-plane/package.json
RUN cd control-plane && npm install --omit=dev

COPY control-plane ./control-plane
COPY web ./web

ENV NODE_ENV=production \
    PORT=8080 \
    ADB_BIN=adb \
    DOCKER_BIN=docker

EXPOSE 8080

# One shared adb server for every session; starting it up front avoids a
# race where several sessions each try to spawn their own.
CMD ["sh", "-c", "adb start-server && node control-plane/src/index.js"]
