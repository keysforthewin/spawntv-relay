FROM node:22-bookworm-slim

# ffmpeg does the HLS packaging; yt-dlp (with curl_cffi for sites behind Cloudflare, like Kick) does the fetching.
# yt-dlp's site support changes weekly: leave YTDLP_VERSION empty for the newest, and rebuild
# (`docker compose build --no-cache`) when a site stops working.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG YTDLP_VERSION=
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]${YTDLP_VERSION:+==${YTDLP_VERSION}}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/tmp/relay \
    CONTROL_PORT=8080 \
    STREAM_PORT=8081
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.CONTROL_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
