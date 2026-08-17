# syntax=docker/dockerfile:1
# Tryout image: wrangler dev / pnpm run-local. Not production workerd.
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts ./
COPY wrangler.jsonc ./
COPY packages ./packages
COPY scripts ./scripts
COPY test-setup ./test-setup
COPY run-dev-server.js ./
COPY deploy/k8s/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend build

# Root on purpose: the data PVC is typically root-owned; this is a VPN tryout, not a hardened prod image.
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]
