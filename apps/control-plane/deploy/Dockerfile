# The control plane's image (D-221). Built from the repository root:
#
#   docker build -f apps/control-plane/deploy/Dockerfile -t novus-control-plane .
#
# The control plane runs its TypeScript directly (--experimental-strip-types),
# so the only build step is the contracts package's dist. The image serves
# plain HTTP on NOVUS_CP_PORT; TLS is the reverse proxy's job
# (ARCHITECTURE.md#deployment), and the container never binds loopback-only —
# inside a container, loopback would mean unreachable.

FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/control-plane/package.json apps/control-plane/
RUN pnpm install --frozen-lockfile --filter @novus/contracts --filter @novus/control-plane

FROM deps AS build
COPY packages/contracts packages/contracts
RUN pnpm --filter @novus/contracts build

FROM node:24-alpine
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/contracts packages/contracts
COPY --from=deps /repo/apps/control-plane/package.json apps/control-plane/package.json
COPY --from=build /repo/apps/control-plane/node_modules apps/control-plane/node_modules
COPY apps/control-plane/src apps/control-plane/src
ENV NODE_ENV=production
ENV NOVUS_CP_HOST=0.0.0.0
EXPOSE 4460
WORKDIR /repo/apps/control-plane
CMD ["node", "--experimental-strip-types", "src/main.ts"]
