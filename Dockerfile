# The base stage owns the Node major: the other stages start from it, CI
# installs the major it names (scripts/node-major.sh), and @types/node must
# match it. node-eol is that major's end-of-life date in Node's release
# schedule, and pnpm test fails after it (scripts/node-runtime.mts).
# node-eol: 2028-04-30
FROM node:24-alpine AS base

FROM base AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
RUN pnpm run build:server
RUN pnpm prune --prod

FROM base
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/build/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/views ./views
COPY --from=build /app/public ./public
COPY --from=build /app/us-east-1-bundle.pem ./us-east-1-bundle.pem

EXPOSE 3000

CMD ["node", "--enable-source-maps", "server/index.js"]
