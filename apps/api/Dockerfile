FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
RUN npm install --omit=dev
ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace=@creolab/api"]
