#!/usr/bin/env python3
# Who is behind a channel link: prints { platform, slug, name, avatarExt } as JSON, and saves the streamer's picture to
# <out>.<avatarExt>. Kick, Twitch and YouTube; anything else prints {}. Sites behind Cloudflare (Kick) need curl_cffi's
# browser impersonation, which yt-dlp's [curl-cffi] extra already installs.
#   python3 streamer.py <channel url> <avatar path without extension> [<channel page hint, e.g. yt-dlp's channel_url>]
import json
import re
import sys
from urllib.parse import urlparse

from curl_cffi import requests

TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"  # twitch.tv's own public web client id
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_AVATAR = 2_000_000


def get(url, **kw):
    return requests.get(url, impersonate="chrome", timeout=15, **kw)


def kick(slug):
    d = get(f"https://kick.com/api/v2/channels/{slug}").json()
    u = d.get("user") or {}
    return {"slug": d.get("slug") or slug, "name": u.get("username") or slug, "avatar": u.get("profile_pic")}


def twitch(login):
    q = {"query": '{user(login:%s){login displayName profileImageURL(width:300)}}' % json.dumps(login)}
    r = requests.post("https://gql.twitch.tv/gql", json=q, headers={"Client-Id": TWITCH_CLIENT_ID}, impersonate="chrome", timeout=15)
    u = ((r.json() or {}).get("data") or {}).get("user") or {}
    return {"slug": u.get("login") or login, "name": u.get("displayName") or login, "avatar": u.get("profileImageURL")}


def meta(html, prop):
    m = re.search(r'<meta property="og:%s" content="([^"]+)"' % prop, html)
    return m.group(1).replace("&amp;", "&") if m else None


def youtube(page):
    html = get(page).text
    handle = re.search(r'"canonicalBaseUrl":"/(@[^"]+)"', html) or re.search(r'youtube\.com/(@[\w.\-]+)', page)
    slug = handle.group(1) if handle else None
    return {"slug": slug, "name": meta(html, "title") or slug, "avatar": meta(html, "image")}


def lookup(url, hint):
    u = urlparse(url)
    host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    parts = [p for p in u.path.split("/") if p]
    if host == "kick.com" and parts:
        return "kick", kick(parts[0].lower())
    if host == "twitch.tv" and parts and parts[0] not in ("videos", "directory"):
        return "twitch", twitch(parts[0].lower())
    if host in ("youtube.com", "youtu.be"):
        if parts and (parts[0].startswith("@") or parts[0] in ("channel", "c", "user")):
            n = 1 if parts[0].startswith("@") else 2
            return "youtube", youtube("https://www.youtube.com/" + "/".join(parts[:n]))
        if hint:  # a /watch or youtu.be link: the channel page yt-dlp found for it
            return "youtube", youtube(hint)
        return "youtube", {}
    return None, {}


def main():
    url, out = sys.argv[1], sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].startswith("https://") else None
    platform, info = lookup(url, hint)
    res = {"platform": platform, "slug": info.get("slug"), "name": info.get("name")}
    pic = info.get("avatar")
    if pic and pic.startswith("https://"):
        try:
            r = get(pic)
            ext = EXT.get(r.headers.get("content-type", "").split(";")[0].strip())
            if r.status_code == 200 and ext and len(r.content) <= MAX_AVATAR:
                with open(f"{out}.{ext}", "wb") as f:
                    f.write(r.content)
                res["avatarExt"] = ext
        except Exception as e:  # a name without a picture is still worth having
            print(f"avatar: {e}", file=sys.stderr)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
