FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# Prisma's generator is a development dependency needed during installation.
# The API also serves the built web application on Render.
RUN npm ci --include=dev \
    && npm run build --workspace=@creolab/web \
    && npm prune --omit=dev --ignore-scripts
RUN node --experimental-strip-types scripts/check-word-runtime.mjs
ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace=@creolab/api"]
