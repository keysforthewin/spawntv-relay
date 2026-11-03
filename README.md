# stream-relay

A password-gated relay that turns any URL yt-dlp can read (Kick, Twitch, YouTube, …) into a plain HLS stream with open CORS,
so a browser page on another site, such as a Spawn world's video texture, can play it.

```
POST :8080/streams {password, url}  →  { id, playUrl }
GET  :8081/s/<id>/index.m3u8        →  the live stream (Access-Control-Allow-Origin: *)
```

One Node process (Express) listens on both ports. For each requested URL it runs `yt-dlp -o - <url> | ffmpeg … -f hls`.
ffmpeg writes a rolling window of 2-second segments to RAM (tmpfs), and the stream port serves that window to any number of viewers.
Everyone watching an id sees the same live point, like a TV channel. A VOD (a YouTube video, say) is paced to real time, so it plays the same way.

## Run

```sh
cp .env.example .env        # then set RELAY_PASSWORD (openssl rand -base64 24)
docker compose up --build
```

## API (control port, 8080)

The password goes in the JSON body as `password`, or as `Authorization: Bearer <password>`.
Ten wrong passwords from one IP lock that IP out for 10 minutes.

| Call | Body | Answer |
|---|---|---|
| `POST /streams` | `{ password, url, wait? }` | `201 { id, playUrl, title, isLive, status: "live", … }` once the first segments exist (waits up to `READY_SECONDS`). If that URL is already running, `200` with its id and `reused: true`. `wait: false` answers `202` at once with `status: "starting"`. `502 { error }` if yt-dlp or ffmpeg fails. |
| `GET /streams` | – | every stream, with its status and recent viewer count |
| `GET /streams/:id` | – | one stream |
| `DELETE /streams/:id` | – | stops it |
| `GET /healthz` | – | no password needed |

```sh
curl -s -X POST localhost:8080/streams -H 'content-type: application/json' \
  -d '{"password":"…","url":"https://kick.com/somechannel"}'
```

## Stream port (8081)

Only `GET /s/<id>/index.m3u8` and `GET /s/<id>/seg_NNNNNN.ts` exist there. The id is 128 random bits, and an unknown id, any other path,
or a failed stream answers a bare 404. The port never fetches anything on request, so it can't be used to pull arbitrary URLs.
Anyone who has an id can watch that stream. Hand out play URLs the way you would an unlisted link.

A stream stops by itself when nobody has fetched it for `IDLE_SECONDS` (default 5 min), or when the source ends.
It stays readable for `KEEP_ENDED_SECONDS` after that, and then its files are deleted.

## Production behind nginx

Keep `BIND_ADDRESS=127.0.0.1` (the default) so only nginx reaches the ports, and set `PUBLIC_STREAM_BASE` to the stream hostname
so `playUrl` comes back as https.

```nginx
# control
server {
  listen 443 ssl; http2 on;
  server_name relay-api.example.com;
  # ssl_certificate …;
  client_max_body_size 16k;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;          # POST waits for the first segments
  }
}

# stream
server {
  listen 443 ssl; http2 on;
  server_name relay.example.com;
  # ssl_certificate …;
  location /s/ {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering on;               # the app already sends the CORS headers; don't add a second copy here
  }
  location / { return 404; }
}
```

The relay trusts `X-Forwarded-For` only from loopback and private addresses (`TRUST_PROXY`), so the lockout counts real client IPs
behind nginx.

## Notes

- Codecs: H.264 sources (Kick, Twitch, most YouTube) are copied without re-encoding. Anything else is transcoded to H.264
  (`TRANSCODE=auto`), which costs CPU. Audio is always AAC.
- yt-dlp's generic extractor is off (`ALLOW_GENERIC=false`), so only sites yt-dlp has a dedicated extractor for are accepted. This also
  keeps the relay from being pointed at internal addresses. Set it to `true` to allow raw `.m3u8`/`.mp4` links and arbitrary pages.
- Sites change, and yt-dlp keeps up. Rebuild with `docker compose build --no-cache` to pull the newest version.
- Rebroadcasting someone else's stream may be against that site's terms. This relay is meant for private use behind the password.
