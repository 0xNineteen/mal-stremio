FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data/user-lists data-seed \
  && cp data/*.json data-seed/ 2>/dev/null || true \
  && chmod +x docker-entrypoint.sh \
  && chown -R node:node /app

USER node

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3001) + '/configure', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]