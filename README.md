# stream-relay

Turns a Kick, Twitch or YouTube link into a live HLS stream that the Spawn TV can play.

## Run

```sh
git clone https://github.com/keysforthewin/stream-relay.git
cd stream-relay
cp .env.example .env
nano .env                  # set RELAY_PASSWORD
docker compose up -d --build
```

## Configure

`.env` needs one line:

```sh
RELAY_PASSWORD=your-long-random-password    # make one with: openssl rand -base64 24
```

All other settings are optional. `.env.example` lists them.

The relay listens on `127.0.0.1:8080` (control) and `127.0.0.1:8081` (streams).
The TV needs both ports behind one HTTPS address. In nginx:

```nginx
location /stream/control/ { proxy_pass http://127.0.0.1:8080/; proxy_read_timeout 120s; proxy_set_header X-Forwarded-For $remote_addr; }
location /stream/relay/   { proxy_pass http://127.0.0.1:8081/; proxy_set_header X-Forwarded-For $remote_addr; }
```

Then, on the TV, open **TV Settings → Relay**:

- Relay address: `https://your-domain.com/stream`
- Relay password: the `RELAY_PASSWORD` from `.env`

## YouTube

YouTube blocks most servers. To fix this, export a cookies file from a logged-in browser and copy it in:

```sh
docker compose cp cookies.txt relay:/data/cookies.txt && docker compose restart
```

Kick and Twitch work without cookies.
