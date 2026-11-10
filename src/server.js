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
const PLAYLIST_MAX = Number(env("PLAYLIST_MAX", 200)); // videos read from a YouTube playlist
const CHANNEL_MAX = Number(env("CHANNEL_MAX", 50)); // a YouTube channel plays from its newest this many videos
if (!ALLOW_GENERIC) YTDLP_COMMON.push("--use-extractors", "default,-generic");
// YouTube wants a "PO token" with most downloads. yt-dlp can't make one itself: the bgutil provider (the `pot` service in
// docker-compose.yml, with its yt-dlp plugin installed in the image) does, and this is its address.
const POT_BASE_URL = env("POT_BASE_URL", "");
if (POT_BASE_URL) YTDLP_COMMON.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`);
const CHANNEL_RETRY_MAX_SECONDS = Number(env("CHANNEL_RETRY_MAX_SECONDS", 600)); // the wait doubles with each failed start, up to this

// The cookies file is looked for on every run, so adding or replacing it needs no restart. Each run gets its own copy: yt-dlp
// writes the jar back when it exits, and overlapping runs would otherwise write over each other.
let cookieN = 0;
async function cookieArgs() {
  if (!fs.existsSync(COOKIES_FILE)) return { args: [], done: () => {} };
  const f = path.join(DATA_DIR, `.cookies-${process.pid}-${++cookieN}.txt`);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.copyFile(COOKIES_FILE, f);
  await fsp.chmod(f, 0o600);
  return { args: ["--cookies", f], done: () => fsp.rm(f, { force: true }).catch(() => {}) };
}

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
 *   kind?: "video" | "live" | "playlist" | "channel", pending?: boolean,
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
// What a YouTube link is: "video" (a /watch, youtu.be, /shorts or /live link), "playlist" (anything with list=), "channel"
// (/@handle, /channel/…, /c/…, /user/…), or null for another site.
function youtubeKind(raw) {
  const u = new URL(raw), host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;
  if (u.searchParams.get("list")) return "playlist";
  if (host === "youtu.be") return "video";
  const p = u.pathname.split("/").filter(Boolean);
  if (p[0]?.startsWith("@") || ["channel", "c", "user"].includes(p[0])) return p.at(-1) === "live" ? "video" : "channel";
  return "video";
}
// A channel link without its tab: https://www.youtube.com/@handle
function youtubeChannelBase(raw) {
  const p = new URL(raw).pathname.split("/").filter(Boolean);
  return "https://www.youtube.com/" + p.slice(0, p[0].startsWith("@") ? 1 : 2).join("/");
}
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// A picture for a channel that has no streamer: a video's (or a playlist's first video's) thumbnail, kept beside the avatars.
const THUMB_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
async function saveThumb(c, videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(String(videoId ?? ""))) return false;
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, { signal: AbortSignal.timeout(10_000) });
    const ext = THUMB_EXT[(r.headers.get("content-type") ?? "").split(";")[0].trim()];
    const body = Buffer.from(await r.arrayBuffer());
    if (!r.ok || !ext || body.length > 2_000_000) return false;
    await fsp.mkdir(AVATAR_DIR, { recursive: true });
    for (const f of await fsp.readdir(AVATAR_DIR)) if (f.startsWith(`${c.key}.`)) await fsp.rm(path.join(AVATAR_DIR, f), { force: true });
    await fsp.writeFile(path.join(AVATAR_DIR, `${c.key}.${ext}`), body);
    Object.assign(c, { avatar: `${c.key}.${ext}`, streamerAt: Date.now() });
    return true;
  } catch { return false; }
}

// Name a channel and give it a picture, from what its link is:
//   a YouTube video      its title and its thumbnail            (kind "video")
//   a live YouTube video its creator's name and picture         (kind "live"), like Kick and Twitch
//   a YouTube playlist   the playlist's title, its first video's thumbnail (kind "playlist")
//   a YouTube channel    the creator's name and picture         (kind "channel")
// Answers a warning when the link couldn't be read now. A YouTube link that couldn't be read is `pending` and is described
// again on its next save, at the next boot, and when it first plays.
async function describe(c) {
  const yt = youtubeKind(c.url), rename = (n) => { if (!c.named && n) c.name = String(n).slice(0, 60).trim(); };
  try {
    if (yt === "playlist") {
      const l = await listEntries(c.url, 1);
      rename(l.title);
      Object.assign(c, { platform: "youtube", kind: "playlist", slug: undefined, streamer: l.channel ?? undefined });
      await saveThumb(c, l.entries[0]?.id);
    } else if (yt === "channel") {
      Object.assign(c, { platform: "youtube", kind: "channel" });
      if (!(await lookUpStreamer(c)) || !c.streamer) throw new Error("couldn't read that channel's page");
    } else {
      const info = await probe(c.url, yt ? 3 : 1);
      if (yt && !info.isLive) {
        rename(info.title);
        Object.assign(c, { platform: "youtube", kind: "video", slug: undefined, streamer: info.channel ?? undefined });
        await saveThumb(c, info.id);
      } else {
        if (!c.streamer) rename(info.title);
        await lookUpStreamer(c, info.channelUrl);
        if (yt) c.kind = "live";
      }
    }
    delete c.pending;
    return undefined;
  } catch (e) {
    if (yt) Object.assign(c, { platform: "youtube", pending: true });
    else await lookUpStreamer(c); // an offline Kick or Twitch channel still has a streamer
    return `saved, but it doesn't play right now: ${e.message}`;
  }
}
const streamerStale = (c) => !c.streamerAt || Date.now() - c.streamerAt > STREAMER_REFRESH_DAYS * 86_400_000;
const needsDescribe = (c) => {
  const yt = youtubeKind(c.url);
  if (!yt) return streamerStale(c);
  return c.pending || !c.kind || ((c.kind === "channel" || c.kind === "live") && streamerStale(c));
};
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
  s.started = startStream(s).then(() => { if (channel) failStreak.delete(channel); }).catch((e) => {
    s.error = s.error ?? e.message;
    stopStream(s, "failed");
    if (channel) failStreak.set(channel, { n: (failStreak.get(channel)?.n ?? 0) + 1, at: Date.now() });
    log(s, "failed:", s.error, channel ? `(next try in ${retryWait(channel)}s)` : "");
  });
  return s;
}

// A channel whose start failed waits before its next try, twice as long after each failure in a row (20 s, 40 s, … 10 min):
// a player asks for the playlist every few seconds, and a site that is refusing us refuses harder when asked that often.
const failStreak = new Map(); // channel key → { n: failed starts in a row, at: when the last one failed }
const retryWait = (key) => {
  const f = failStreak.get(key);
  return f ? Math.min(CHANNEL_RETRY_MAX_SECONDS, CHANNEL_RETRY_SECONDS * 2 ** (f.n - 1)) : 0;
};
// The stream a channel's viewer should read now, starting one when none is running (null: none can start right now).
function channelStream(c) {
  const s = streamOfChannel(c.key);
  if (s && active(s)) return s;
  const f = failStreak.get(c.key);
  if (f && Date.now() - f.at < retryWait(c.key) * 1000) return null;
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

async function ytdlp(args, timeoutMs) {
  const ck = await cookieArgs();
  try { return await run("yt-dlp", [...YTDLP_COMMON, ...ck.args, ...args], timeoutMs); } finally { ck.done(); }
}

// Read one video's facts. `tries` > 1 asks again after a refusal (YouTube turns a server away at random). With `keep`, yt-dlp's
// whole answer is also written to that file, so the download that follows reads it (--load-info-json) instead of asking the
// site a second time.
async function probe(url, tries = 1, keep) {
  let r;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((res) => setTimeout(res, 1500));
    r = await ytdlp(["-J", "-f", FORMAT, "--", url], 90_000);
    if (r.code === 0) break;
  }
  if (r.code !== 0) throw new Error(tail(r.err) || "yt-dlp could not read that URL");
  const info = JSON.parse(r.out);
  if (keep) await fsp.writeFile(keep, r.out);
  const fmts = info.requested_formats ?? [info];
  const pick = (k) => fmts.map((f) => f[k]).find((c) => c && c !== "none") ?? "none";
  return { id: info.id ?? null, title: info.title ?? null, isLive: info.is_live === true, vcodec: pick("vcodec"), acodec: pick("acodec"),
    duration: Number(info.duration) || null, channel: info.channel ?? info.uploader ?? null,
    channelUrl: info.channel_url ?? info.uploader_url ?? null, infoFile: keep ?? null };
}

// The videos of a YouTube playlist or channel tab, in the site's order (a channel's newest first): { title, channel, entries: [{ id, title }] }.
async function listEntries(url, max) {
  let r;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((res) => setTimeout(res, 1500));
    r = await ytdlp(["--yes-playlist", "--flat-playlist", "--playlist-end", String(max), "-J", "--", url], 90_000);
    if (r.code === 0) break;
  }
  if (r.code !== 0) throw new Error(tail(r.err) || "yt-dlp could not read that list");
  const info = JSON.parse(r.out);
  const entries = (info.entries ?? []).filter((e) => e && /^[A-Za-z0-9_-]{6,20}$/.test(String(e.id ?? "")) && e.live_status !== "is_upcoming")
    .map((e) => ({ id: e.id, title: e.title ?? null }));
  if (!entries.length) throw new Error("that list has no videos");
  return { title: info.title ?? null, channel: info.channel ?? info.uploader ?? null, entries };
}

// What a stream plays, one item after another: next() answers { url, info? } or null when there is nothing more.
//   a YouTube playlist  its videos in order, then from the top again; a channel's place in it is remembered while the relay runs
//   a YouTube channel   its live broadcast when it has one, then its newest video, then its other recent videos in random order
//   a YouTube video     over and over (a live one once)
//   anything else       once, as before (a Kick or Twitch broadcast)
const cursors = new Map(); // channel key → index of the playlist video that is playing
async function makeQueue(s) {
  const yt = youtubeKind(s.url);
  if (yt === "playlist") {
    let list = await listEntries(s.url, PLAYLIST_MAX);
    const v = new URL(s.url).searchParams.get("v"); // a /watch link inside a playlist starts at that video
    let i = s.channel && cursors.has(s.channel) ? cursors.get(s.channel) : Math.max(0, list.entries.findIndex((e) => e.id === v));
    return { loops: true, maxFails: 5, next: async () => {
      if (i >= list.entries.length) { i = 0; list = await listEntries(s.url, PLAYLIST_MAX).catch(() => list); }
      if (s.channel) cursors.set(s.channel, i);
      return { url: watchUrl(list.entries[i++].id) };
    } };
  }
  if (yt === "channel") {
    const base = youtubeChannelBase(s.url);
    const recent = async () => (await listEntries(`${base}/videos`, CHANNEL_MAX).catch(() => listEntries(`${base}/streams`, CHANNEL_MAX))).entries.map((e) => e.id);
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let ids = null, first = true, last = null;
    return { loops: true, maxFails: 5, next: async () => {
      if (first) {
        first = false;
        const live = await probe(`${base}/live`, 1, path.join(DATA_DIR, `.info-${newId()}.json`)).catch(() => null);
        if (live?.isLive) return { url: `${base}/live`, info: live };
        if (live?.infoFile) fsp.rm(live.infoFile, { force: true }).catch(() => {});
      }
      if (!ids) { const all = await recent(); ids = [all[0], ...shuffle(all.slice(1))]; }
      else if (!ids.length) { ids = shuffle(await recent()); if (ids.length > 1 && ids[0] === last) ids.push(ids.shift()); }
      last = ids.shift();
      return { url: watchUrl(last) };
    } };
  }
  if (yt === "video") {
    let done = false;
    return { loops: true, maxFails: 2, next: async () => (done ? null : { url: s.url, after: (info) => { done = info.isLive; } }) };
  }
  let given = false;
  return { loops: false, maxFails: 1, next: async () => (given ? null : ((given = true), { url: s.url })) };
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

// Old segments of earlier items: ffmpeg only deletes the ones written by its own run, so the ones the playlist has moved past
// are removed here before each new item.
async function sweepSegments(s) {
  try {
    const seq = Number((await fsp.readFile(path.join(s.dir, "index.m3u8"), "utf8")).match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);
    if (!Number.isFinite(seq)) return;
    for (const f of await fsp.readdir(s.dir)) {
      const n = Number(f.match(/^seg_(\d+)\.ts$/)?.[1]);
      if (Number.isFinite(n) && n < seq - 4) await fsp.rm(path.join(s.dir, f), { force: true });
    }
  } catch {}
}

// Play one item into the stream's playlist; answers true when it played through to its end. The first item starts the playlist;
// each later one is appended to it after a discontinuity mark, so a player keeps reading the same address through a whole
// playlist. `onStart(info)` is called once yt-dlp and ffmpeg are running.
async function playItem(s, item, onStart) {
  const info = item.info ?? await probe(item.url, s.queue.loops ? 2 : 1, path.join(DATA_DIR, `.info-${newId()}.json`));
  try {
    if (!active(s)) return false; // stopped while probing
    if (info.vcodec === "none") throw new Error("that URL has no video track");
    Object.assign(s, { title: info.title, isLive: info.isLive });
    item.after?.(info);
    s.videoDelay = settings.videoDelay; // fixed for this run of ffmpeg; a change restarts the stream
    s.transcode = TRANSCODE === "always" || (TRANSCODE === "auto" && !/^(avc1|h264)/i.test(info.vcodec));
    const playlist = path.join(s.dir, "index.m3u8");
    const append = fs.existsSync(playlist);
    if (append) await sweepSegments(s);

    const video = s.transcode
      ? ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
         "-vf", `scale=-2:'min(${MAX_HEIGHT},ih)'`,
         "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
      : ["-c:v", "copy"];
    const ffArgs = [
      "-hide_banner", "-loglevel", "error",
      // A VOD is paced to real time so it plays like a channel. Its decode timestamps are ignored: in yt-dlp's merged MPEG-TS
      // a 60 fps picture arrives with some unset, and with the sound re-encoded beside it the HLS muxer then stops cutting
      // segments after the first two (the video sat at 10 seconds for good).
      ...(s.isLive ? [] : ["-re", "-fflags", "+igndts"]),
      "-i", "pipe:0",
      "-map", "0:v:0", "-map", "0:a:0?",
      ...video,
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      ...delayArgs(s),
      "-f", "hls",
      "-hls_time", String(SEGMENT_SECONDS),
      "-hls_list_size", String(LIST_SIZE),
      // The first item numbers its segments from the clock; an appended item carries on from the playlist's own count.
      ...(append ? [] : ["-hls_start_number_source", "epoch"]),
      "-hls_delete_threshold", "4",
      "-hls_flags", "delete_segments+independent_segments+temp_file" + (s.queue.loops ? "+omit_endlist" : "") + (append ? "+append_list+discont_start" : ""),
      "-hls_segment_filename", path.join(s.dir, "seg_%06d.ts"),
      playlist,
    ];

    const ck = await cookieArgs();
    const yt = spawn("yt-dlp", [...YTDLP_COMMON, ...ck.args, "-f", FORMAT, "--no-part", "-o", "-", "--load-info-json", info.infoFile],
      { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const ff = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "ignore", "pipe"], detached: true });
    s.procs = [yt, ff];
    let ytErr = "", ffErr = "";
    yt.stderr.on("data", (d) => (ytErr = (ytErr + d).slice(-4000)));
    ff.stderr.on("data", (d) => (ffErr = (ffErr + d).slice(-4000)));
    ff.stdin.on("error", () => {}); // EPIPE when ffmpeg goes first
    yt.stdout.on("error", () => {});
    yt.stdout.pipe(ff.stdin);
    const closed = (p) => new Promise((res) => { p.on("close", (code) => res(code)); p.on("error", () => res(-1)); });
    const ytDone = closed(yt), ffDone = closed(ff);
    ffDone.then(() => killGroup(yt));
    log(s, `started ${s.isLive ? "live" : "vod"} ${info.vcodec}/${info.acodec}${s.transcode ? " (transcoding)" : ""}${s.videoDelay ? `, video delay ${s.videoDelay}s` : ""}: ${s.title}`);
    onStart?.(info);

    const [ytCode, ffCode] = await Promise.all([ytDone, ffDone]);
    ck.done();
    log(s, `yt-dlp exited ${ytCode}, ffmpeg exited ${ffCode}`);
    if (!active(s)) return false;
    if (ytCode) throw new Error(tail(ytErr) || `yt-dlp exited ${ytCode}`);
    if (ffCode) throw new Error(tail(ffErr) || "the stream produced no video");
    return true;
  } finally {
    if (info.infoFile) fsp.rm(info.infoFile, { force: true }).catch(() => {});
  }
}

// Play the stream's items one after another until it is stopped, runs out, or too many in a row fail.
async function playLoop(s) {
  let fails = 0, nextP = null, timer = null;
  const fetchNext = async () => {
    const item = await s.queue.next();
    if (item && !item.info) item.info = await probe(item.url, 2, path.join(DATA_DIR, `.info-${newId()}.json`)).catch(() => undefined);
    return item;
  };
  // The next item is read shortly before this one ends, so the gap between two videos is only ffmpeg's start.
  const onStart = (info) => {
    const c = s.channel && channels.get(s.channel);
    if (c?.pending) describe(c).then(saveChannels).catch(() => {});
    if (!s.queue.loops || info.isLive || !info.duration) return;
    timer = setTimeout(() => { if (active(s)) nextP = fetchNext().catch(() => null); }, Math.max(0, info.duration - 90) * 1000);
    timer.unref();
  };
  const end = (status) => {
    if (active(s)) { s.status = s.status === "starting" ? "failed" : status; scheduleCleanup(s); }
  };
  while (active(s)) {
    let item;
    try { item = nextP ? ((await nextP) ?? (await fetchNext())) : await s.queue.next(); }
    catch (e) { s.error = e.message; item = undefined; }
    nextP = null;
    if (!active(s)) break;
    if (item === null) return end("ended");
    let ok = false;
    if (item) {
      try { ok = await playItem(s, item, onStart); }
      catch (e) { s.error = e.message; if (active(s)) log(s, `item failed (${item.url}): ${e.message}`); }
    }
    clearTimeout(timer);
    if (ok) { fails = 0; s.error = undefined; }
    else if (active(s) && ++fails >= s.queue.maxFails) return end("ended"); // "failed" when nothing ever played
  }
  if (nextP) nextP.then((it) => it?.info?.infoFile && fsp.rm(it.info.infoFile, { force: true })).catch(() => {});
}

async function startStream(s) {
  s.queue = await makeQueue(s);
  if (!active(s)) return;
  await fsp.mkdir(s.dir, { recursive: true });
  playLoop(s).catch((e) => { s.error = s.error ?? e.message; stopStream(s, "failed"); });
  const playlist = path.join(s.dir, "index.m3u8");
  const deadline = Date.now() + READY_SECONDS * 1000;
  while (s.status === "starting" && Date.now() < deadline) {
    if (fs.existsSync(playlist)) { s.status = "live"; s.lastSeen = Date.now(); log(s, "ready", playUrl(s)); return; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (s.status === "starting") throw new Error(`no video after ${READY_SECONDS}s`);
  if (s.status === "failed") throw new Error(s.error ?? "the stream failed");
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

// Save a URL as a channel: { password, url, name? } → { key, name, url, playUrl, platform, kind, slug, streamer, avatarUrl }. The same
// URL saved twice is one channel. Its name is the given name, else what describe() finds: the streamer (Kick, Twitch, a live
// YouTube, a YouTube channel), a YouTube video's title, a playlist's title.
// A link that can't be read right now (a channel that is offline) is still saved, with `warning`.
control.post("/channels", requirePassword, async (req, res) => {
  const url = parseUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "url must be an http(s) URL" });
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  for (const c of channels.values()) if (c.url === url) {
    let changed = false, warning;
    if (name && name !== c.name) { Object.assign(c, { name, named: true }); changed = true; }
    if (needsDescribe(c)) { warning = await describe(c); changed = true; }
    if (changed) await saveChannels();
    return res.json({ ...channelView(c), reused: true, warning });
  }
  const c = { key: newId(), url, name: name || new URL(url).host + new URL(url).pathname, createdAt: new Date().toISOString() };
  if (name) c.named = true;
  const warning = await describe(c);
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
// Channels whose name and picture are missing or old (needsDescribe) get them in the background, one at a time.
(async () => {
  let n = 0;
  for (const c of channels.values()) if (needsDescribe(c)) { await describe(c); n++; }
  if (n) { await saveChannels(); log(null, `described ${n} channel(s) again`); }
})().catch((e) => console.error("streamer backfill:", e.message));
control.listen(CONTROL_PORT, () => log(null, `control on :${CONTROL_PORT}`));
stream.listen(STREAM_PORT, () => log(null, `stream on :${STREAM_PORT} → ${PUBLIC_STREAM_BASE}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const s of streams.values()) for (const p of s.procs ?? []) killGroup(p);
    setTimeout(() => process.exit(0), 300);
  });
}
