# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy source and build
COPY server ./server
RUN cd server && npm run build

# ── Production image ────────────────────────────────────────

FROM node:20-alpine

LABEL org.opencontainers.image.title="Mergen" \
      org.opencontainers.image.description="Local-first browser observability for AI" \
      org.opencontainers.image.url="https://github.com/omertt27/Mergen" \
      org.opencontainers.image.source="https://github.com/omertt27/Mergen" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/

# Copy extension (for serving via /extension endpoint if needed)
COPY extension ./extension

# Create data directory with explicit permissions — 700 so only the node user
# can read/write secrets and SQLite databases stored there.
RUN mkdir -p /app/.mergen && chown -R node:node /app && chmod 700 /app/.mergen

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Start server
CMD ["node", "server/dist/index.js"]
