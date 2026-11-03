// SpawnTV Relay: a password-gated yt-dlp → HLS relay for the Spawn TV.
//
//   control port  POST /streams {password, url}  → { id, playUrl }   (yt-dlp | ffmpeg → rolling HLS on disk)
//   stream port   GET  /s/<id>/index.m3u8 (+ segments)               (open CORS; only known ids, nothing fetched on demand)
//
// One process, two Express apps. The stream id is 128 random bits and is the only key a viewer needs, so a game page
// can use the play URL as a plain texture address. Without an id nobody can pull anything through the stream port,
// and only a caller holding the password can make the relay fetch a URL.

import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);

const PASSWORD = env("RELAY_PASSWORD", "");
if (!PASSWORD) {
  console.error("RELAY_PASSWORD must be set (see .env.example)");
  process.exit(1);
}
if (PASSWORD.length < 12) console.warn("warning: RELAY_PASSWORD is short; use 12+ random characters in production");
const CONTROL_PORT = Number(env("CONTROL_PORT", 8080));
const STREAM_PORT = Number(env("STREAM_PORT", 8081));
const DATA_DIR = env("DATA_DIR", "/tmp/relay");
const PUBLIC_STREAM_BASE = env("PUBLIC_STREAM_BASE", `http://localhost:${STREAM_PORT}`).replace(/\/+$/, "");
const MAX_STREAMS = Number(env("MAX_STREAMS", 4));
const IDLE_SECONDS = Number(env("IDLE_SECONDS", 300)); // stop a stream nobody has fetched for this long
const READY_SECONDS = Number(env("READY_SECONDS", 60)); // how long POST waits for the first segments
const KEEP_ENDED_SECONDS = Number(env("KEEP_ENDED_SECONDS", 120)); // ended streams stay readable this long
const SEGMENT_SECONDS = Number(env("SEGMENT_SECONDS", 2));
const LIST_SIZE = Number(env("LIST_SIZE", 8)); // segments in the live window
const TRANSCODE = env("TRANSCODE", "auto"); // auto: re-encode only non-H.264 video · always · never
const MAX_HEIGHT = Number(env("MAX_HEIGHT", 1080));
// The picture plays this many seconds after the sound it came with (the sound's timestamps shifted earlier), to line them up when
// the player's sound runs late. 0 turns it off; a negative value delays the sound instead. This env value is only the starting
// point: POST /settings { videoDelay } changes it at runtime (the SpawnTV's Relay tab does), kept in SETTINGS_FILE.
const VIDEO_DELAY_SECONDS = Number(env("VIDEO_DELAY_SECONDS", 0));
const MAX_DELAY_SECONDS = 20;
const ALLOW_GENERIC = env("ALLOW_GENERIC", "false") === "true"; // yt-dlp's generic extractor (any page / raw media URL)
const TRUST_PROXY = env("TRUST_PROXY", "loopback, uniquelocal");
const CHANNELS_FILE = env("CHANNELS_FILE", "/data/channels.json"); // saved channels survive restarts here
const CHANNEL_WAIT_SECONDS = Number(env("CHANNEL_WAIT_SECONDS", 25)); // a channel's first playlist fetch waits this long for its start
const CHANNEL_RETRY_SECONDS = Number(env("CHANNEL_RETRY_SECONDS", 20)); // after a failed start (channel offline), wait before trying again

const FORMAT = env(
  "YTDLP_FORMAT",
  [
    `bv*[vcodec^=avc1][height<=${MAX_HEIGHT}]+ba[acodec^=mp4a]`,
    `b[vcodec^=avc1][height<=${MAX_HEIGHT}]`,
    `bv*[height<=${MAX_HEIGHT}]+ba`,
    `b[height<=${MAX_HEIGHT}]`,
    "b",
  ].join("/"),
);
// YouTube needs a JavaScript runtime (Node is in the image) and, from a server IP, usually a logged-in cookies file: put one at
// COOKIES_FILE (Netscape format, e.g. exported with a "cookies.txt" browser extension from a throwaway account) and it is used.
const COOKIES_FILE = env("COOKIES_FILE", "/data/cookies.txt");
// Each channel's streamer picture, saved when the channel is (src/streamer.py) and served at <stream>/a/<key>.<ext>.
const AVATAR_DIR = env("AVATAR_DIR", path.join(path.dirname(CHANNELS_FILE), "avatars"));
const STREAMER_PY = path.join(path.dirname(new URL(import.meta.url).pathname), "streamer.py");
const SETTINGS_FILE = env("SETTINGS_FILE", path.join(path.dirname(CHANNELS_FILE), "settings.json"));
const clampDelay = (v) => Math.max(-MAX_DELAY_SECONDS, Math.min(MAX_DELAY_SECONDS, Math.round((Number(v) || 0) * 10) / 10));
const settings = { videoDelay: clampDelay(VIDEO_DELAY_SECONDS) };
const STREAMER_REFRESH_DAYS = Number(env("STREAMER_REFRESH_DAYS", 7)); // a re-save after this long looks the streamer up again
const YTDLP_COMMON = ["--ignore-config", "--no-warnings", "--no-progress", "--no-playlist", "--js-runtimes", "node"];
if (fs.existsSync(COOKIES_FILE)) YTDLP_COMMON.push("--cookies", COOKIES_FILE);
if (!ALLOW_GENERIC) YTDLP_COMMON.push("--use-extractors", "default,-generic");

// ---------------------------------------------------------------- auth

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const PASSWORD_HASH = sha(PASSWORD);
const passwordOk = (p) => typeof p === "string" && crypto.timingSafeEqual(sha(p), PASSWORD_HASH);

const failures = new Map(); // ip → { n, until }
const FAIL_LIMIT = 10, FAIL_WINDOW_MS = 10 * 60_000;

function requirePassword(req, res, next) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.n >= FAIL_LIMIT && Date.now() < f.until) return res.status(429).json({ error: "too many failed attempts" });
  const header = req.get("authorization") ?? "";
  const given = req.body?.password ?? (header.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!passwordOk(given)) {
    const cur = f && Date.now() < f.until ? f : { n: 0, until: Date.now() + FAIL_WINDOW_MS };
    cur.n++;
    failures.set(ip, cur);
    return res.status(401).json({ error: "bad password" });
  }
  failures.delete(ip);
  next();
}

// ---------------------------------------------------------------- streams

/** @type {Map<string, any>} */
const streams = new Map();
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
// Segments are numbered from the Unix time their stream started (hls_start_number_source epoch), so a channel's restart never
// reuses a segment address: a cache anywhere between here and the player (Spawn's texture fetcher included) can't hand back
// an earlier run's picture under the same name, and the playlist's media sequence only ever counts up.
const FILE_RE = /^(index\.m3u8|seg_\d{6,12}\.ts)$/;

const newId = () => crypto.randomBytes(16).toString("base64url");
const playUrl = (s) => (s.channel ? channelUrl(s.channel) : `${PUBLIC_STREAM_BASE}/s/${s.id}/index.m3u8`);
const channelUrl = (key) => `${PUBLIC_STREAM_BASE}/c/${key}/index.m3u8`;
const tail = (buf) => buf.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 600);
const active = (s) => s.status === "starting" || s.status === "live";
const log = (s, ...a) => console.log(new Date().toISOString(), s ? `[${s.id.slice(0, 6)}]` : "", ...a);

function publicView(s) {
  const now = Date.now();
  for (const [ip, t] of s.viewers) if (now - t > 30_000) s.viewers.delete(ip);
  return {
    id: s.id,
    url: s.url,
    title: s.title,
    isLive: s.isLive,
    status: s.status,
    error: s.error ?? undefined,
    transcoding: s.transcode,
    viewers: s.viewers.size,
    createdAt: new Date(s.createdAt).toISOString(),
    lastFetchAt: new Date(s.lastSeen).toISOString(),
    channel: s.channel ?? undefined,
    playUrl: playUrl(s),
  };
}

// ---------------------------------------------------------------- saved channels
// A channel is a saved URL with a permanent, unguessable key. Its play URL never changes: the first fetch after it went idle
// (or after the source went offline) starts yt-dlp again. Saving one takes the password; watching one takes only the key, and a
// key can only ever start the URL it was saved with.

/** @type {Map<string, { key: string, url: string, name: string, named?: boolean, platform?: string, slug?: string,
 *   streamer?: string, avatar?: string, streamerAt?: number, createdAt: string }>} */
const channels = new Map();
async function loadChannels() {
  try {
    for (const c of JSON.parse(await fsp.readFile(CHANNELS_FILE, "utf8"))) channels.set(c.key, c);
    log(null, `loaded ${channels.size} channel(s) from ${CHANNELS_FILE}`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("could not read", CHANNELS_FILE, e.message);
  }
}
async function loadSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(SETTINGS_FILE, "utf8"));
    if (Number.isFinite(saved.videoDelay)) settings.videoDelay = clampDelay(saved.videoDelay);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("could not read", SETTINGS_FILE, e.message);
  }
  log(null, `video delay ${settings.videoDelay}s`);
}
async function saveSettings() {
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fsp.writeFile(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 1));
  await fsp.rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
}
async function saveChannels() {
  await fsp.mkdir(path.dirname(CHANNELS_FILE), { recursive: true });
  const tmp = `${CHANNELS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify([...channels.values()], null, 1));
  await fsp.rename(tmp, CHANNELS_FILE);
}
const channelView = (c) => {
  const s = streamOfChannel(c.key);
  const avatarUrl = c.avatar ? `${PUBLIC_STREAM_BASE}/a/${c.avatar}?v=${c.streamerAt ?? 0}` : undefined;
  return { ...c, avatarUrl, playUrl: channelUrl(c.key), status: s?.status ?? "idle", title: s?.title ?? undefined };
};

// Who streams on this channel (src/streamer.py): Kick, Twitch and YouTube give their slug, display name and picture. The
// channel is named after the streamer, never the stream's title (it changes every broadcast), unless the saver named it.
async function lookUpStreamer(c, hint) {
  await fsp.mkdir(AVATAR_DIR, { recursive: true });
  const r = await run("python3", [STREAMER_PY, c.url, path.join(AVATAR_DIR, c.key), hint ?? ""], 45_000);
  let m = null;
  try { m = JSON.parse(r.out.trim().split("\n").pop()); } catch {}
  if (r.code !== 0 || !m) { log(null, `channel ${c.key.slice(0, 6)}: no streamer info (${tail(r.err) || r.code})`); return false; }
  for (const f of await fsp.readdir(AVATAR_DIR)) // an older picture under another extension
    if (f.startsWith(`${c.key}.`) && f !== `${c.key}.${m.avatarExt}`) await fsp.rm(path.join(AVATAR_DIR, f), { force: true });
  Object.assign(c, {
    platform: m.platform ?? undefined, slug: m.slug ?? undefined, streamer: m.name ?? undefined,
    avatar: m.avatarExt ? `${c.key}.${m.avatarExt}` : undefined, streamerAt: Date.now(),
  });
  if (!c.named) c.name = String(m.name || m.slug || c.name).slice(0, 60);
  return true;
}
const streamerStale = (c) => !c.video && (!c.streamerAt || Date.now() - c.streamerAt > STREAMER_REFRESH_DAYS * 86_400_000);
const streamOfChannel = (key) => {
  let best;
  for (const s of streams.values()) if (s.channel === key && (!best || s.createdAt > best.createdAt)) best = s;
  return best;
};
const activeCount = () => [...streams.values()].filter(active).length;

function parseUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { return null; }
  return /^https?:$/.test(url.protocol) && url.href.length <= 2048 ? url.href : null;
}

// Make a stream for `url` and start it in the background; the returned promise settles when it is live or failed.
function createStream(url, channel) {
  const id = newId();
  const s = { id, url, channel, title: null, isLive: null, status: "starting", createdAt: Date.now(), lastSeen: Date.now(),
              dir: path.join(DATA_DIR, id), viewers: new Map(), procs: [], transcode: false };
  streams.set(id, s);
  s.started = startStream(s).catch((e) => {
    s.error = s.error ?? e.message;
    stopStream(s, "failed");
    log(s, "failed:", s.error);
  });
  return s;
}

// The stream a channel's viewer should read now, starting one when none is running (null: none can start right now).
function channelStream(c) {
  const s = streamOfChannel(c.key);
  if (s && active(s)) return s;
  if (s?.status === "failed" && Date.now() - s.createdAt < CHANNEL_RETRY_SECONDS * 1000) return null;
  if (activeCount() >= MAX_STREAMS) return null;
  const n = createStream(c.url, c.key);
  log(n, `channel ${c.key.slice(0, 6)} (${c.name}) starting for a viewer`);
  return n;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
  });
}

async function probe(url) {
  const r = await run("yt-dlp", [...YTDLP_COMMON, "-J", "-f", FORMAT, "--", url], 90_000);
  if (r.code !== 0) throw new Error(tail(r.err) || "yt-dlp could not read that URL");
  const info = JSON.parse(r.out);
  const fmts = info.requested_formats ?? [info];
  const pick = (k) => fmts.map((f) => f[k]).find((c) => c && c !== "none") ?? "none";
  return { title: info.title ?? null, isLive: info.is_live === true, vcodec: pick("vcodec"), acodec: pick("acodec"),
    channelUrl: info.channel_url ?? info.uploader_url ?? null };
}

function killGroup(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  try { process.kill(-p.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 5000).unref();
}

// The delay is made in the sound (it is re-encoded anyway; the picture is copied), and both tracks still start at the same instant,
// because a player that starts the picture and the sound separately (Spawn's does) lines up each track's first sample and would
// cancel a lead in the timestamps (the first way this was done: the setts filter, then asetpts alone; neither changed what was heard).
// Picture late by d: the sound's first d seconds are cut, so from then on the sound is d seconds ahead of the picture beside it.
// Sound late by d (negative): the sound starts with d seconds of silence.
function delayArgs(s) {
  const d = s.videoDelay;
  if (!Number.isFinite(d) || d === 0) return [];
  return ["-af", d > 0 ? `asetpts=PTS-(${d})/TB,atrim=start=0` : `adelay=${Math.round(-d * 1000)}:all=1`];
}

async function startStream(s) {
  const info = await probe(s.url);
  if (!active(s)) return; // stopped while probing
  Object.assign(s, { title: info.title, isLive: info.isLive });
  if (info.vcodec === "none") throw new Error("that URL has no video track");
  s.videoDelay = settings.videoDelay; // fixed for this run of ffmpeg; a change restarts the stream
  s.transcode = TRANSCODE === "always" || (TRANSCODE === "auto" && !/^(avc1|h264)/i.test(info.vcodec));
  await fsp.mkdir(s.dir, { recursive: true });

  const video = s.transcode
    ? ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
       "-vf", `scale=-2:'min(${MAX_HEIGHT},ih)'`,
       "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
    : ["-c:v", "copy"];
  const ffArgs = [
    "-hide_banner", "-loglevel", "error",
    ...(s.isLive ? [] : ["-re"]), // a VOD is paced to real time so it plays like a channel
    "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0?",
    ...video,
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    ...delayArgs(s),
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_list_size", String(LIST_SIZE),
    "-hls_start_number_source", "epoch",
    "-hls_delete_threshold", "4",
    "-hls_flags", "delete_segments+independent_segments+temp_file",
    "-hls_segment_filename", path.join(s.dir, "seg_%06d.ts"),
    path.join(s.dir, "index.m3u8"),
  ];

  const yt = spawn("yt-dlp", [...YTDLP_COMMON, "-f", FORMAT, "--no-part", "-o", "-", "--", s.url],
    { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const ff = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "ignore", "pipe"], detached: true });
  s.procs = [yt, ff];
  let ytErr = "", ffErr = "";
  yt.stderr.on("data", (d) => (ytErr = (ytErr + d).slice(-4000)));
  ff.stderr.on("data", (d) => (ffErr = (ffErr + d).slice(-4000)));
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg goes first
  yt.stdout.on("error", () => {});
  yt.stdout.pipe(ff.stdin);

  yt.on("close", (code) => {
    log(s, `yt-dlp exited ${code}`);
    if (code && active(s)) s.error = tail(ytErr) || `yt-dlp exited ${code}`;
  });
  ff.on("close", (code) => {
    log(s, `ffmpeg exited ${code}`);
    killGroup(yt);
    if (!active(s)) return;
    if (s.status === "starting") {
      s.status = "failed";
      s.error = s.error ?? (tail(ffErr) || "the stream produced no video");
    } else s.status = "ended";
    scheduleCleanup(s);
  });

  log(s, `started ${s.isLive ? "live" : "vod"} ${info.vcodec}/${info.acodec}${s.transcode ? " (transcoding)" : ""}${s.videoDelay ? `, video delay ${s.videoDelay}s` : ""}: ${s.title}`);
  const playlist = path.join(s.dir, "index.m3u8");
  const deadline = Date.now() + READY_SECONDS * 1000;
  while (s.status === "starting" && Date.now() < deadline) {
    if (fs.existsSync(playlist)) { s.status = "live"; s.lastSeen = Date.now(); log(s, "ready", playUrl(s)); return; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (s.status === "starting") throw new Error(`no video after ${READY_SECONDS}s`);
}

function stopStream(s, why) {
  if (active(s)) { s.status = why === "failed" ? "failed" : "ended"; log(s, `stopping (${why})`); }
  for (const p of s.procs ?? []) killGroup(p);
  scheduleCleanup(s);
}

function scheduleCleanup(s) {
  if (s.cleanup) return;
  s.cleanup = setTimeout(async () => {
    streams.delete(s.id);
    await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    log(s, "removed");
  }, KEEP_ENDED_SECONDS * 1000);
  s.cleanup.unref();
}

// Idle reaper: nobody fetched the playlist or a segment for IDLE_SECONDS → stop it.
setInterval(() => {
  const now = Date.now();
  for (const s of streams.values()) if (active(s) && now - s.lastSeen > IDLE_SECONDS * 1000) stopStream(s, "idle");
}, 15_000).unref();

// ---------------------------------------------------------------- control app (password)

const control = express();
control.disable("x-powered-by");
control.set("trust proxy", TRUST_PROXY);
// Open CORS: a game's in-browser menu calls this API directly. Every call but /healthz needs the password, and no cookies are used.
control.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
control.use(express.json({ limit: "16kb" }));

control.get("/healthz", (_req, res) => res.json({ ok: true, streams: activeCount(), channels: channels.size }));

control.post("/streams", requirePassword, async (req, res) => {
  const url = parseUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "url must be an http(s) URL" });

  // Same URL already running → share it (two viewers, one relay).
  for (const s of streams.values()) if (s.url === url && active(s)) return res.status(200).json({ ...publicView(s), reused: true });
  if (activeCount() >= MAX_STREAMS) return res.status(503).json({ error: `already relaying ${MAX_STREAMS} streams; DELETE one first` });

  const s = createStream(url);
  log(s, `requested ${url} from ${req.ip}`);
  if (req.body?.wait === false) return res.status(202).json(publicView(s));
  await s.started;
  if (s.status === "live") return res.status(201).json(publicView(s));
  return res.status(502).json({ ...publicView(s), error: s.error ?? "stream failed" });
});

// Save a URL as a channel: { password, url, name? } → { key, name, url, playUrl, platform, slug, streamer, avatarUrl }. The same URL
// saved twice is one channel. Its name is the given name, else the streamer's (Kick, Twitch, a live YouTube), else the title
// (a YouTube video that isn't live keeps its title: `video: true`, no picture).
// The URL is checked with yt-dlp first; one that can't play right now (a channel that is offline) is still saved, with `warning`.
control.post("/channels", requirePassword, async (req, res) => {
  const url = parseUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "url must be an http(s) URL" });
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  for (const c of channels.values()) if (c.url === url) {
    let changed = false;
    if (name && name !== c.name) { Object.assign(c, { name, named: true }); changed = true; }
    if (streamerStale(c)) changed = (await lookUpStreamer(c)) || changed;
    if (changed) await saveChannels();
    return res.json({ ...channelView(c), reused: true });
  }
  let info = null, warning;
  try { info = await probe(url); } catch (e) { warning = `saved, but it doesn't play right now: ${e.message}`; }
  const c = { key: newId(), url, name: name || info?.title?.slice(0, 60) || new URL(url).host + new URL(url).pathname, createdAt: new Date().toISOString() };
  if (name) c.named = true;
  // A YouTube video that isn't live keeps its video's title and has no streamer picture; a live one (or a channel link) is
  // named after its creator, like Kick and Twitch.
  const host = new URL(url).hostname.replace(/^(www|m)\./, "");
  if (info && !info.isLive && (host === "youtube.com" || host === "youtu.be")) Object.assign(c, { platform: "youtube", video: true });
  else await lookUpStreamer(c, info?.channelUrl);
  channels.set(c.key, c);
  await saveChannels();
  log(null, `channel ${c.key.slice(0, 6)} saved: ${c.name} ← ${url} (from ${req.ip})`);
  return res.status(201).json({ ...channelView(c), warning });
});

// Is this a Spawn account? { exists, name, kind: "person" | "agent" | null }. Spawn has no public user search; a person's profile
// lives at spawn.co/@name and an agent's at spawn.co/@@name, so the answer is whether either page exists. Cached 10 minutes.
const spawnUsers = new Map();
control.get("/spawn-user/:name", requirePassword, async (req, res) => {
  const name = String(req.params.name ?? "").replace(/^@+/, "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(name)) return res.status(400).json({ error: "a Spawn username is letters, digits and _" });
  const hit = spawnUsers.get(name);
  if (hit && Date.now() - hit.at < 600_000) return res.json(hit.v);
  const status = async (prefix) => {
    const r = await fetch(`https://www.spawn.co/${prefix}${encodeURIComponent(name)}`, { redirect: "manual", headers: { "user-agent": "spawntv-relay" }, signal: AbortSignal.timeout(8000) });
    return r.status;
  };
  try {
    const [person, agent] = await Promise.all([status("@"), status("@@")]);
    const v = { name, exists: person === 200 || agent === 200, kind: person === 200 ? "person" : agent === 200 ? "agent" : null };
    spawnUsers.set(name, { at: Date.now(), v });
    return res.json(v);
  } catch {
    return res.status(502).json({ error: "couldn't reach spawn.co to check" });
  }
});

control.get("/channels", requirePassword, (_req, res) => res.json([...channels.values()].map(channelView)));

control.delete("/channels/:key", requirePassword, async (req, res) => {
  const c = channels.get(req.params.key);
  if (!c) return res.status(404).json({ error: "no such channel" });
  channels.delete(c.key);
  await saveChannels();
  for (const s of streams.values()) if (s.channel === c.key && active(s)) stopStream(s, "channel deleted");
  return res.json({ deleted: c.key });
});

// The relay's settings: { videoDelay } (seconds the picture plays behind its sound; negative holds the sound back). A change
// restarts every running stream at once with the new delay, so viewers see a few seconds' gap.
control.get("/settings", requirePassword, (_req, res) => res.json({ ...settings, maxDelay: MAX_DELAY_SECONDS }));
control.post("/settings", requirePassword, async (req, res) => {
  const body = req.body ?? {};
  if ("videoDelay" in body) {
    const v = Number(body.videoDelay);
    if (body.videoDelay === null || body.videoDelay === "" || !Number.isFinite(v)) return res.status(400).json({ error: "videoDelay must be a number of seconds" });
    const next = clampDelay(v);
    if (next !== settings.videoDelay) {
      settings.videoDelay = next;
      await saveSettings();
      log(null, `video delay set to ${next}s from ${req.ip}; restarting running streams`);
      for (const s of [...streams.values()]) {
        if (!active(s)) continue;
        stopStream(s, "video delay changed");
        const c = s.channel && channels.get(s.channel);
        if (c) channelStream(c);
      }
    }
  }
  return res.json({ ...settings, maxDelay: MAX_DELAY_SECONDS });
});

control.get("/streams", requirePassword, (_req, res) => res.json([...streams.values()].map(publicView)));

control.get("/streams/:id", requirePassword, (req, res) => {
  const s = streams.get(req.params.id);
  return s ? res.json(publicView(s)) : res.status(404).json({ error: "no such stream" });
});

control.delete("/streams/:id", requirePassword, (req, res) => {
  const s = streams.get(req.params.id);
  if (!s) return res.status(404).json({ error: "no such stream" });
  stopStream(s, "deleted");
  return res.json(publicView(s));
});

control.use((_req, res) => res.status(404).json({ error: "not found" }));

// ---------------------------------------------------------------- stream app (open CORS, id-gated)

const stream = express();
stream.disable("x-powered-by");
stream.disable("etag");
stream.set("trust proxy", TRUST_PROXY);
stream.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Access-Control-Allow-Private-Network": "true",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Timing-Allow-Origin": "*",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

stream.get("/s/:id/:file", (req, res) => {
  const { id, file } = req.params;
  const s = ID_RE.test(id) && FILE_RE.test(file) ? streams.get(id) : undefined;
  if (!s || s.status === "failed") return res.status(404).end();
  serveFile(req, res, s, file);
});

// A saved channel: its key is its address for good. The first playlist fetch after it went idle starts it and waits for it.
stream.get("/c/:key/:file", async (req, res) => {
  const { key, file } = req.params;
  const c = ID_RE.test(key) && FILE_RE.test(file) ? channels.get(key) : undefined;
  if (!c) return res.status(404).end();
  let s = streamOfChannel(key);
  if (file === "index.m3u8") {
    if (!s || !active(s)) s = channelStream(c);
    if (!s) return res.status(503).set("Retry-After", String(CHANNEL_RETRY_SECONDS)).end();
    s.lastSeen = Date.now();
    if (s.status === "starting") await Promise.race([s.started, new Promise((r) => setTimeout(r, CHANNEL_WAIT_SECONDS * 1000))]);
    if (s.status !== "live" && s.status !== "ended") return res.status(503).set("Retry-After", "5").end();
  }
  if (!s || s.status === "failed") return res.status(404).end();
  serveFile(req, res, s, file);
});

function serveFile(req, res, s, file) {
  s.lastSeen = Date.now();
  s.viewers.set(req.ip, s.lastSeen);
  const isPlaylist = file.endsWith(".m3u8");
  res.set({
    "Content-Type": isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t",
    "Cache-Control": isPlaylist ? "no-cache, no-store" : "public, max-age=60",
  });
  res.sendFile(path.join(s.dir, file), { dotfiles: "deny", lastModified: false, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

// A channel's streamer picture (lookUpStreamer). Its URL carries ?v=<when it was looked up>, so it can be cached long.
const AVATAR_RE = /^[A-Za-z0-9_-]{22}\.(png|jpg|webp|gif)$/;
stream.get("/a/:file", (req, res) => {
  const { file } = req.params;
  if (!AVATAR_RE.test(file) || !channels.get(file.split(".")[0])?.avatar) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(AVATAR_DIR, file), { dotfiles: "deny", lastModified: false, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

stream.use((_req, res) => res.status(404).end());

// ---------------------------------------------------------------- boot

await loadChannels();
await loadSettings();
await fsp.mkdir(DATA_DIR, { recursive: true });
for (const leftover of await fsp.readdir(DATA_DIR)) await fsp.rm(path.join(DATA_DIR, leftover), { recursive: true, force: true });
// Channels saved before streamer lookups existed (or long ago) get their streamer in the background, one at a time.
(async () => {
  let n = 0;
  for (const c of channels.values()) if (streamerStale(c) && (await lookUpStreamer(c))) n++;
  if (n) { await saveChannels(); log(null, `looked up the streamer of ${n} channel(s)`); }
})().catch((e) => console.error("streamer backfill:", e.message));
control.listen(CONTROL_PORT, () => log(null, `control on :${CONTROL_PORT}`));
stream.listen(STREAM_PORT, () => log(null, `stream on :${STREAM_PORT} → ${PUBLIC_STREAM_BASE}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const s of streams.values()) for (const p of s.procs ?? []) killGroup(p);
    setTimeout(() => process.exit(0), 300);
  });
}
