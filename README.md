# SpawnTV Relay

The Spawn TV in game needs this relay to play anything. It turns a Kick, Twitch or YouTube link into a live stream the TV can play.
Run it on your own Linux server.

## Run

```sh
git clone https://github.com/keysforthewin/spawntv-relay.git
cd spawntv-relay
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

Then, in game, open **TV Settings → Relay** on the Spawn TV:

- Relay address: `https://your-domain.com/stream`
- Relay password: the `RELAY_PASSWORD` from `.env`

## YouTube

YouTube blocks most servers. To fix this, export a cookies file from a logged-in browser and copy it in (no restart needed):

```sh
docker compose cp cookies.txt relay:/data/cookies.txt
```

What a YouTube link plays:

- a video: that video, on repeat
- a live stream: the broadcast
- a playlist (any link with `list=`): its videos in order, then from the top again
- a channel (`youtube.com/@name`): its live broadcast if there is one, then its newest video, then its other recent videos at random

Kick and Twitch work without cookies.

## Sound and picture out of step

If the TV's sound plays behind its picture, set **Picture delay** on the TV's Relay tab to hold the picture back by that many
seconds (−20 to 20; a negative number holds the sound back instead). It is the relay's setting, kept in `/data/settings.json`,
and applies to every channel. Running channels restart with it, so viewers see a few seconds' gap. `VIDEO_DELAY_SECONDS` in
`.env` is only its starting value.
