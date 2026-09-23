FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core openssl ca-certificates default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN mkdir -p apps/api/kalkan-verify/build \
    && javac -d apps/api/kalkan-verify/build apps/api/kalkan-verify/VerifyServer.java
# Prisma's generator is a development dependency needed during installation.
# The API also serves the built web application on Render.
RUN npm ci --include=dev \
    && npm run build --workspace=@creolab/web \
    && npm prune --omit=dev --ignore-scripts
RUN node --experimental-strip-types scripts/check-word-runtime.mjs
ENV NODE_ENV=production
CMD ["node", "scripts/start-api-with-kalkan.mjs"]
