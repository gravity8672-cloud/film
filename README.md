# 🎬 CineSync

Watch movies together with your friends — perfectly synced, no matter where they are.

**▶️ Live site:** https://gravity8672-cloud.github.io/film/

---

## What it does

- **👑 Host-controlled playback** — only the **host** (the person who created the room) can play, pause, seek, or switch the video. Everyone else just follows along, so the stream stays smooth even with lots of people in the room. Any member can press **🎬 Take control** to become the host (handy if the host leaves).
- **🔄 Synced playback** — when the host hits play, pause, or seeks, everyone's movie jumps to the same spot automatically. A background heartbeat keeps everyone in sync and corrects drift.
- **➕ Add-URL playlist** — paste your movie links and build a queue. Supports:
  - Direct video files (`.mp4`, `.webm`, `.mov`)
  - HLS live streams (`.m3u8`)
  - YouTube links
- **🔗 Room codes & invite links** — create a room, share the link, friends join instantly.
- **💬 Live chat** — talk with your friends while you watch.
- **📱 Works on phones** — iPhone, iPad, and Android (just tap the video once to start, due to mobile autoplay rules).

## How it works

CineSync has **no backend server**. Playback sync runs **peer-to-peer over WebRTC**, with signaling handled by free public relays. That's why it can be hosted as a plain static site for free.

The actual movie is **not streamed from one person to another** — each viewer's browser loads the video directly from the movie link using their own internet connection. Only the tiny sync signals (play/pause/seek) and chat are shared between peers.

## How to use

1. Open the live site.
2. Enter your name → **Create a room**.
3. Paste a movie link → **Add to playlist**.
4. Click **🔗 Share link** and send it to your friends.
5. Friends open the link, enter a name, and they're watching with you. 🍿

## Notes

- Movie links must be **publicly reachable direct links** so everyone can load them.
- Hosting requires **HTTPS** (GitHub Pages provides this automatically). It will not work when opened as a local `file://` page.
- Some browsers (e.g. Brave) may block WebRTC via shields — lower shields for the site if it won't connect.

## Changing the lobby background

The lobby background is a single image at the repo root: **`lucy-bg.jpg`**. To change it, just **replace that file, keeping the exact same name** (`styles.css` points to `url("lucy-bg.jpg")`, so no code change is needed):

1. In the repo, open `lucy-bg.jpg` → delete it → commit.
2. **Add file → Upload files**, upload your new image **renamed to exactly `lucy-bg.jpg`** → commit.
3. Wait ~1 min for GitHub Pages to redeploy, then hard-refresh (Ctrl+Shift+R).

**Recommended image specs:**

| Spec | Recommendation |
| --- | --- |
| Aspect ratio | **16:9** (landscape / widescreen) |
| Resolution | **1920×1080** ideal; **1200×675 minimum** |
| Format | **JPG** (or PNG if it has transparency) |
| File size | Keep **under ~1 MB** so the page loads fast on GitHub Pages |
| Filename | Must be exactly **`lucy-bg.jpg`** |
| Composition | The lobby card sits **centered**, so put the main subject **off to one side** (or use a scene/landscape) — anything dead-center will be hidden behind the card |

**Cache tip:** the image URL has no version number, so browsers may keep showing the old picture after a swap. To force an update for everyone, bump the version in `styles.css` — change `url("lucy-bg.jpg")` to `url("lucy-bg.jpg?v=2")` (increase the number each time).

## Tech

- Vanilla HTML / CSS / JavaScript
- [hls.js](https://github.com/video-dev/hls.js) for HLS playback
- [Trystero](https://github.com/dmotz/trystero) for serverless peer-to-peer sync
- YouTube IFrame API for YouTube videos

---

Made with 🍿 for movie nights.
