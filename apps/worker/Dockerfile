FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
RUN npm install --omit=dev
ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace=@creolab/worker"]
