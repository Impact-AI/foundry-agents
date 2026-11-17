# The backend, run directly on Bun: Bun executes the TypeScript source and the
# `bun` built-ins the platform packages use, so there is no build step. Build
# context is the repository root.
#   docker build -f apps/backend/Dockerfile -t backend .

# --- deps ---
FROM oven/bun:1.4.4 AS deps
WORKDIR /repo
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
# Every workspace manifest, and only the manifest of the one this image does
# not run: bun.lock records the whole workspace set and `--frozen-lockfile`
# refuses a set that does not match it, without naming the missing one;
# src/dockerfile.test.ts names it before a build does.
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
# The platform packages are what this app runs on; they come across whole.
COPY platform ./platform
RUN bun install --frozen-lockfile
COPY apps/backend ./apps/backend

# --- runtime ---
FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=4111
# The base image is as it was built when its Bun was released, and stays so
# for as long as that Bun is the one `.bun-version` names: its packages are
# brought to the distribution's fixed releases here, which is what the
# pipeline's image scan then reads. The slim image also carries no CA bundle;
# Azure's Node-compatible clients need the operating-system trust store.
RUN apt-get update -qq \
	&& DEBIAN_FRONTEND=noninteractive apt-get upgrade -qq --no-install-recommends \
	&& apt-get install -qq --no-install-recommends ca-certificates \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*
# The installed tree part by part, so what runs here is only what runs here,
# and the dependency layer stays byte-identical across an edit to this app.
# The workspace link under node_modules to the frontend dangles on purpose:
# nothing in this image's import graph resolves it.
COPY --from=deps --chown=bun:bun /repo/node_modules /repo/node_modules
COPY --from=deps --chown=bun:bun /repo/platform /repo/platform
COPY --from=deps --chown=bun:bun /repo/apps/backend /repo/apps/backend
COPY --from=deps --chown=bun:bun /repo/package.json /repo/bun.lock /repo/bunfig.toml /repo/tsconfig.base.json /repo/
WORKDIR /repo/apps/backend
# Nothing here needs root: the port is above 1024 and `bun` (uid 1000) ships in the image.
USER bun
EXPOSE 4111
# Bun 1.3 stopped consulting the operating-system CA store by default.
CMD ["bun", "--use-system-ca", "run", "src/index.ts"]
