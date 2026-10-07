FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV CODEX_HOME=/home/nextjs/.codex
ARG CODEX_CLI_VERSION=0.143.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /home/nextjs/.codex \
  && chown -R nextjs:nodejs /home/nextjs

RUN npm install --global --no-audit --no-fund @openai/codex@${CODEX_CLI_VERSION} \
  && codex --version

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/db ./db

USER nextjs
EXPOSE 3000
CMD ["sh", "-c", "node scripts/check-production-env.mjs && node server.js"]
