FROM node:22-bookworm-slim AS workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.27.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json prettier.config.mjs ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/ap/package.json packages/ap/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/switch/package.json packages/switch/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages

FROM node:22-bookworm-slim AS server
WORKDIR /app/apps/server
COPY --from=workspace /app /app
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/index.ts"]

FROM workspace AS web-build
RUN pnpm --filter @repo/web build

FROM nginx:1.29-alpine AS web
COPY deploy/raspberry-pi/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
