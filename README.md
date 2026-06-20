# 🎬 CineSync

Watch movies together with your friends — perfectly synced, no matter where they are.

**▶️ Live site:** https://gravity8672-cloud.github.io/film/

---

## What it does

- **🔄 Synced playback** — when anyone hits play, pause, or seeks, everyone's movie jumps to the same spot automatically. A background heartbeat keeps everyone in sync and corrects drift.
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

## Tech

- Vanilla HTML / CSS / JavaScript
- [hls.js](https://github.com/video-dev/hls.js) for HLS playback
- [Trystero](https://github.com/dmotz/trystero) for serverless peer-to-peer sync
- YouTube IFrame API for YouTube videos

---

Made with 🍿 for movie nights.
