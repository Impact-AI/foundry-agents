# Next.js (standalone) frontend. Build context is the repository root:
#   docker build -f apps/frontend/Dockerfile -t frontend .
#
# No build arguments: this image depends on nothing outside git, and every
# environment-specific value is a runtime variable.

# --- manifests ---
# The frozen install resolves the whole workspace set against bun.lock, so
# every workspace manifest has to be present — and only the manifests: another
# app's source is not build input for this image, but for the one file below. Docker's COPY flattens a
# glob, so the manifests are gathered here, paths preserved, and copied below.
FROM node:26-slim AS manifests
WORKDIR /repo
COPY . .
RUN mkdir -p /manifests \
	&& find . \( -path ./node_modules -o -name node_modules -o -name '.next*' -o -name .git \) -prune \
	   -o -name package.json -print \
	   | while read -r f; do mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; done \
	&& cp package.json bun.lock bunfig.toml tsconfig.base.json /manifests/

# --- build ---
# Node base + the Bun binary: bun does the frozen install, `next build` runs
# under Node, which is what serves the image.
FROM node:26-slim AS build
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile
# Workspace packages ship as source, so the ones this app compiles come whole.
COPY platform ./platform
# The product's languages: one list, which this app imports from the backend;
# and a measure's key as words, the name the catalogues fall back on.
COPY apps/backend/src/product/locales.ts ./apps/backend/src/product/locales.ts
COPY apps/backend/src/product/measure-name.ts ./apps/backend/src/product/measure-name.ts
COPY apps/frontend ./apps/frontend
RUN cd apps/frontend && bun run build

# --- runtime ---
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The chat runtime ships an analytics client that is on unless this says
# otherwise. Set in the image, so it holds wherever the image runs.
ENV COPILOTKIT_TELEMETRY_DISABLED=1
# The Node base is as it was built when that tag was last published: its
# packages are brought to the distribution's fixed releases here, which is
# what the pipeline's image scan then reads.
RUN apt-get update -qq \
	&& DEBIAN_FRONTEND=noninteractive apt-get upgrade -qq --no-install-recommends \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /repo/apps/frontend/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/frontend/.next/static ./apps/frontend/.next/static
# The voice worklets, served from this origin as the page's own scripts.
COPY --from=build --chown=node:node /repo/apps/frontend/public ./apps/frontend/public
USER node
EXPOSE 3000
# Next's standalone server with the live voice socket beside it (`server/main.ts`).
CMD ["node", "apps/frontend/main.js"]
