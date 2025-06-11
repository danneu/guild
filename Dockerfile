FROM node:23-alpine

# Install dependencies
RUN apk add --no-cache graphicsmagick

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build assets
RUN npm run build

# Clean dev dependencies and reinstall production only
RUN npm prune --production

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]