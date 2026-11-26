FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS toolchain
WORKDIR /studio
RUN npm install --global pnpm@12.23.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps/web/ apps/web/
COPY packages/contracts/ packages/contracts/
RUN pnpm build

FROM toolchain AS runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter @studio/server...
COPY apps/server/src/ apps/server/src/
COPY apps/server/drizzle/ apps/server/drizzle/
COPY packages/contracts/src/ packages/contracts/src/
COPY --from=build /studio/apps/web/dist/ apps/web/dist/
USER node
EXPOSE 3000
CMD ["node", "apps/server/src/main.ts"]
