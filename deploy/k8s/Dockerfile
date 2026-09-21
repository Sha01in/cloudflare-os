# syntax=docker/dockerfile:1
# Build all application artifacts before the container starts. The final image contains the
# pinned native runtime and prebuilt assets, without a development server or dependency tree.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts ./
COPY wrangler.jsonc ./
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY workerd ./workerd

RUN pnpm workerd:build

# JS/assets are portable; obtain the runtime binary for the target platform separately.
# This avoids running the TypeScript native compiler under cross-architecture emulation.
FROM ${NODE_IMAGE} AS runtime-binary
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /binary
RUN pnpm add --ignore-scripts workerd@1.20260831.1 \
 && mkdir /runtime-bin \
 && node -e 'require("node:fs").copyFileSync(require("workerd").default, "/runtime-bin/workerd")' \
 && chmod 755 /runtime-bin/workerd

FROM ${NODE_IMAGE} AS runtime
# Native workerd uses the OS trust store for OAuth and provider HTTPS requests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    WORKERD_BIN=/usr/local/bin/workerd \
    WORKERD_STATE_DIR=/data/workerd

WORKDIR /app
COPY --from=runtime-binary /runtime-bin/workerd /usr/local/bin/workerd
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/workerd ./workerd
COPY --from=build /app/scripts/workerd ./scripts/workerd
COPY --from=build /app/packages/workshop-frontend/dist ./packages/workshop-frontend/dist
COPY --chmod=755 deploy/k8s/entrypoint.sh /entrypoint.sh

RUN mkdir -p /data/workerd && chown node:node /data/workerd
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
ENTRYPOINT ["/entrypoint.sh"]
