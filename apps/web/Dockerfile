FROM node:24-alpine AS build

RUN npm install --global pnpm@12.6.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/client/package.json apps/web/client/package.json
COPY apps/web/server/package.json apps/web/server/package.json
COPY apps/jobs/authorization-sync/package.json apps/jobs/authorization-sync/package.json
COPY apps/jobs/pricing-sync/package.json apps/jobs/pricing-sync/package.json
COPY apps/jobs/usage-collector/package.json apps/jobs/usage-collector/package.json
COPY apps/jobs/mail-dispatch/package.json apps/jobs/mail-dispatch/package.json
COPY packages/azure/package.json packages/azure/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY apps/jobs apps/jobs
COPY packages packages

RUN pnpm build:packages \
    && pnpm --filter @tokenusagealert/web-client build \
    && pnpm --filter @tokenusagealert/web-server build \
    && pnpm --filter @tokenusagealert/authorization-sync-job build \
    && pnpm --filter @tokenusagealert/pricing-sync-job build \
    && pnpm --filter @tokenusagealert/usage-collector-job build \
    && pnpm --filter @tokenusagealert/mail-dispatch-job build \
    && pnpm --filter @tokenusagealert/web-server --prod deploy /prod/server \
    && pnpm --filter @tokenusagealert/authorization-sync-job --prod deploy /prod/authorization-sync \
    && pnpm --filter @tokenusagealert/pricing-sync-job --prod deploy /prod/pricing-sync \
    && pnpm --filter @tokenusagealert/usage-collector-job --prod deploy /prod/usage-collector \
    && pnpm --filter @tokenusagealert/mail-dispatch-job --prod deploy /prod/mail-dispatch

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /prod/server

COPY --from=build /prod/server /prod/server
COPY --from=build /app/apps/web/client/dist /prod/client/dist
COPY --from=build /prod/authorization-sync /prod/authorization-sync
COPY --from=build /prod/pricing-sync /prod/pricing-sync
COPY --from=build /prod/usage-collector /prod/usage-collector
COPY --from=build /prod/mail-dispatch /prod/mail-dispatch

USER node
EXPOSE 3000

CMD ["node", "dist/index.js"]
