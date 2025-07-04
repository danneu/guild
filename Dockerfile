FROM node:23-alpine

# Install pnpm
RUN corepack enable

WORKDIR /app

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build assets
RUN pnpm run build

# Remove dev dependencies https://pnpm.io/cli/prune
RUN pnpm prune --prod

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "start"]