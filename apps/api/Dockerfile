# Heavy conversion dependencies are build-only; the runtime contains CT2 INT8 weights.
FROM python:3.11-slim-bookworm AS speech-model
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY scripts/speech-build-requirements.txt scripts/install-speech-model.py /build/
RUN pip install --no-cache-dir torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r /build/speech-build-requirements.txt \
    && python /build/install-speech-model.py /model

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core openssl ca-certificates default-jdk-headless python3-venv libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Cache the offline speech engine and pinned multilingual model independently of application changes.
COPY scripts/speech-requirements.txt /opt/basqar-speech/
RUN python3 -m venv /opt/basqar-speech/venv \
    && /opt/basqar-speech/venv/bin/pip install --no-cache-dir -r /opt/basqar-speech/speech-requirements.txt
COPY --from=speech-model /model /opt/basqar-speech/model
ENV TRANSCRIPTION_ENGINE=local
ENV TRANSCRIPTION_PYTHON=/opt/basqar-speech/venv/bin/python
ENV TRANSCRIPTION_MODEL_PATH=/opt/basqar-speech/model
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
