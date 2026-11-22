# صورة لوحة التحكم (Next.js standalone). البناء: docker build -t fleet-web apps/web
# مزوّد بلاطات الخريطة يُثبَّت وقت البناء (NEXT_PUBLIC_*)، وعنوان الخادم API_URL يُعطى وقت التشغيل.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_TILE_URL=""
ARG NEXT_PUBLIC_TILE_ATTRIBUTION=""
ENV NEXT_PUBLIC_TILE_URL=$NEXT_PUBLIC_TILE_URL NEXT_PUBLIC_TILE_ATTRIBUTION=$NEXT_PUBLIC_TILE_ATTRIBUTION NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
