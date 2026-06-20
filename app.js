// ---------------------------------------------------------------------------
// CineSync — serverless watch party.
// Sync runs peer-to-peer over WebRTC; signaling uses public Nostr relays via
// Trystero, so there is NO backend to run. Host it as a static file anywhere.
//
// NOTE: Trystero is loaded dynamically (inside enterRoom) instead of as a
// top-level import. That way the UI always works even if the network module
// fails to load (e.g. opened as a local file:// page), and we can show a clear
// error instead of the whole script dying silently.
// ---------------------------------------------------------------------------
let joinRoom = null

const APP_ID = 'cinesync-watch-party-v1'

// ---- DOM ----
const $ = (id) => document.getElementById(id)
const lobby = $('lobby'), roomEl = $('room')
const nameInput = $('nameInput'), joinCodeInput = $('joinCodeInput')
const createBtn = $('createBtn'), joinBtn = $('joinBtn')
const roomCodeLabel = $('roomCodeLabel'), statusDot = $('statusDot'), statusText = $('statusText'), peerCount = $('peerCount')
const shareBtn = $('shareBtn'), leaveBtn = $('leaveBtn')
const video = $('video'), ytContainer = $('ytContainer'), emptyState = $('emptyState'), playerWrap = $('playerWrap')
const nowPlaying = $('nowPlaying'), resyncBtn = $('resyncBtn'), autoSyncToggle = $('autoSyncToggle')
const addForm = $('addForm'), urlInput = $('urlInput'), titleInput = $('titleInput'), playlistEl = $('playlist')
const chatLog = $('chatLog'), chatForm = $('chatForm'), chatInput = $('chatInput')
const toast = $('toast')

// ---- State ----
let room = null
let myName = 'Guest'
let myId = Math.random().toString(36).slice(2, 9)
let playlist = []          // [{id, url, title, type}]
let currentIndex = -1
let applyingRemote = false  // guard against rebroadcast loops
let hls = null
let ytPlayer = null
let ytReady = false
let activeKind = null       // 'video' | 'youtube'

// Trystero senders (assigned after joinRoom)
let sendCtrl, sendState, sendChat, sendPlaylist, sendHello

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function showToast(msg, ms = 2600) {
  toast.textContent = msg
  toast.classList.remove('hidden')
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms)
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function detectType(url) {
  const u = url.toLowerCase()
  if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/embed/.test(u)) return 'youtube'
  if (u.includes('.m3u8')) return 'hls'
  return 'video'
}

function ytIdFromUrl(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Player abstraction (HTML5 <video>/HLS  +  YouTube IFrame)
// ---------------------------------------------------------------------------
function teardownPlayers() {
  if (hls) { hls.destroy(); hls = null }
  video.removeAttribute('src')
  video.load?.()
  video.classList.add('hidden')
  if (ytPlayer) { try { ytPlayer.stopVideo() } catch {} }
  ytContainer.classList.add('hidden')
}

function loadItem(index, { broadcast = true } = {}) {
  if (index < 0 || index >= playlist.length) return
  currentIndex = index
  const item = playlist[index]
  emptyState.classList.add('hidden')
  teardownPlayers()
  activeKind = item.type === 'youtube' ? 'youtube' : 'video'

  if (activeKind === 'youtube') {
    loadYouTube(item)
  } else {
    video.classList.remove('hidden')
    if (item.type === 'hls' && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls()
      hls.loadSource(item.url)
      hls.attachMedia(video)
    } else {
      video.src = item.url
    }
  }
  nowPlaying.textContent = '▶ ' + item.title
  renderPlaylist()
  if (broadcast) sendCtrl?.({ kind: 'load', index, t: 0 })
}

// ---- YouTube ----
function ensureYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve()
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
    window.onYouTubeIframeAPIReady = () => resolve()
  })
}

async function loadYouTube(item) {
  await ensureYouTubeApi()
  ytContainer.classList.remove('hidden')
  ytContainer.innerHTML = '<div id="ytPlayerEl"></div>'
  const vid = ytIdFromUrl(item.url)
  ytReady = false
  ytPlayer = new window.YT.Player('ytPlayerEl', {
    videoId: vid,
    playerVars: { autoplay: 0, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true },
      onStateChange: onYtStateChange
    }
  })
}

function onYtStateChange(e) {
  if (applyingRemote || activeKind !== 'youtube') return
  const YT = window.YT
  if (e.data === YT.PlayerState.PLAYING) {
    sendCtrl?.({ kind: 'play', t: ytPlayer.getCurrentTime() })
  } else if (e.data === YT.PlayerState.PAUSED) {
    sendCtrl?.({ kind: 'pause', t: ytPlayer.getCurrentTime() })
  }
}

// Unified getters/setters used by sync
function playerGetTime() {
  if (activeKind === 'youtube') return ytReady ? ytPlayer.getCurrentTime() : 0
  return video.currentTime || 0
}
function playerIsPaused() {
  if (activeKind === 'youtube') {
    if (!ytReady) return true
    return ytPlayer.getPlayerState() !== window.YT.PlayerState.PLAYING
  }
  return video.paused
}
function playerPlay() {
  if (activeKind === 'youtube') { ytReady && ytPlayer.playVideo() }
  else video.play().catch(() => {})
}
function playerPause() {
  if (activeKind === 'youtube') { ytReady && ytPlayer.pauseVideo() }
  else video.pause()
}
function playerSeek(t) {
  if (activeKind === 'youtube') { ytReady && ytPlayer.seekTo(t, true) }
  else video.currentTime = t
}

// ---- Local <video> events -> broadcast ----
video.addEventListener('play',  () => { if (!applyingRemote) sendCtrl?.({ kind: 'play',  t: video.currentTime }) })
video.addEventListener('pause', () => { if (!applyingRemote) sendCtrl?.({ kind: 'pause', t: video.currentTime }) })
video.addEventListener('seeked',() => { if (!applyingRemote) sendCtrl?.({ kind: 'seek',  t: video.currentTime }) })

// ---------------------------------------------------------------------------
// Apply remote control events
// ---------------------------------------------------------------------------
function applyControl(msg) {
  applyingRemote = true
  try {
    if (msg.kind === 'load') {
      if (msg.index !== currentIndex) loadItem(msg.index, { broadcast: false })
      return
    }
    const drift = Math.abs(playerGetTime() - msg.t)
    if (msg.kind === 'play') {
      if (drift > 0.6) playerSeek(msg.t)
      playerPlay()
    } else if (msg.kind === 'pause') {
      playerSeek(msg.t)
      playerPause()
    } else if (msg.kind === 'seek') {
      playerSeek(msg.t)
    } else if (msg.kind === 'heartbeat') {
      if (autoSyncToggle.checked && !playerIsPaused() && drift > 1.5) {
        playerSeek(msg.t)
      }
    }
  } finally {
    setTimeout(() => { applyingRemote = false }, 120)
  }
}

// Heartbeat for drift correction (everyone sends; receivers self-correct)
setInterval(() => {
  if (!room || currentIndex < 0 || playerIsPaused()) return
  sendCtrl?.({ kind: 'heartbeat', t: playerGetTime() })
}, 4000)

// ---------------------------------------------------------------------------
// Full-state sync (sent to newcomers)
// ---------------------------------------------------------------------------
function snapshot() {
  return {
    playlist,
    currentIndex,
    t: playerGetTime(),
    paused: playerIsPaused()
  }
}
function applySnapshot(s) {
  if (!s) return
  playlist = s.playlist || []
  renderPlaylist()
  if (s.currentIndex >= 0 && s.currentIndex < playlist.length) {
    applyingRemote = true
    loadItem(s.currentIndex, { broadcast: false })
    const apply = () => {
      playerSeek(s.t || 0)
      if (s.paused) playerPause(); else playerPlay()
      setTimeout(() => { applyingRemote = false }, 200)
    }
    setTimeout(apply, 800)
  }
}

// ---------------------------------------------------------------------------
// Playlist UI
// ---------------------------------------------------------------------------
function renderPlaylist() {
  playlistEl.innerHTML = ''
  if (!playlist.length) {
    playlistEl.innerHTML = '<li class="playlist-empty">No movies yet. Paste a link above to get started. 🎞️</li>'
    return
  }
  playlist.forEach((item, i) => {
    const li = document.createElement('li')
    li.className = 'playlist-item' + (i === currentIndex ? ' active' : '')
    li.innerHTML = `
      <span class="pl-index">${i + 1}</span>
      <div class="pl-body">
        <div class="pl-title">${escapeHtml(item.title)}</div>
        <div class="pl-url">${escapeHtml(item.url)}</div>
      </div>
      <span class="pl-type">${item.type}</span>
      <button class="pl-remove" title="Remove">✕</button>`
    li.querySelector('.pl-body').addEventListener('click', () => loadItem(i))
    li.querySelector('.pl-index').addEventListener('click', () => loadItem(i))
    li.querySelector('.pl-remove').addEventListener('click', (e) => {
      e.stopPropagation()
      removeItem(item.id)
    })
    playlistEl.appendChild(li)
  })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

function addItem(url, title) {
  url = url.trim()
  if (!url) return
  const type = detectType(url)
  if (type === 'youtube' && !ytIdFromUrl(url)) { showToast('Could not read that YouTube link.'); return }
  const item = { id: Math.random().toString(36).slice(2, 9), url, title: (title || '').trim() || guessTitle(url), type }
  playlist.push(item)
  renderPlaylist()
  sendPlaylist?.(playlist)
  if (currentIndex === -1) loadItem(playlist.length - 1)
  showToast('Added to playlist')
}

function removeItem(id) {
  const idx = playlist.findIndex((p) => p.id === id)
  if (idx === -1) return
  const wasCurrent = idx === currentIndex
  playlist.splice(idx, 1)
  if (idx < currentIndex) currentIndex--
  else if (wasCurrent) { currentIndex = -1; teardownPlayers(); emptyState.classList.remove('hidden'); nowPlaying.textContent = '' }
  renderPlaylist()
  sendPlaylist?.(playlist)
}

function guessTitle(url) {
  try {
    if (detectType(url) === 'youtube') return 'YouTube video'
    const name = decodeURIComponent(url.split('/').pop().split('?')[0])
    return name || 'Untitled'
  } catch { return 'Untitled' }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function addChat(who, text, system = false) {
  const div = document.createElement('div')
  div.className = 'chat-msg' + (system ? ' system' : '')
  div.innerHTML = system ? escapeHtml(text) : `<span class="who">${escapeHtml(who)}:</span> ${escapeHtml(text)}`
  chatLog.appendChild(div)
  chatLog.scrollTop = chatLog.scrollHeight
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------
async function enterRoom(code) {
  myName = (nameInput.value || '').trim() || 'Guest'
  code = code.toUpperCase()
  roomCodeLabel.textContent = code
  // Switch to the room view immediately so the button always "does something".
  lobby.classList.add('hidden')
  roomEl.classList.remove('hidden')
  history.replaceState(null, '', '?room=' + code)
  setStatus('connecting')

  // Load the P2P engine on demand, with a clear error if the network blocks it.
  if (!joinRoom) {
    const sources = [
      'https://esm.sh/trystero@0.21.5/nostr',
      'https://cdn.jsdelivr.net/npm/trystero@0.21.5/+esm'
    ]
    for (const src of sources) {
      try {
        const mod = await import(src)
        joinRoom = mod.joinRoom
        if (joinRoom) break
      } catch (e) { /* try next source */ }
    }
    if (!joinRoom) {
      setStatus('error')
      statusText.textContent = 'connection blocked'
      addChat('', '⚠️ Could not load the sync engine. Make sure this page is hosted online (https://) and opened in a normal browser tab — not a local file or a preview window.', true)
      showToast('Sync engine blocked — see chat for details', 6000)
      return
    }
  }

  // RTC config: STUN helps peers find each other; TURN relays the connection
  // when a direct one is impossible (e.g. phone on mobile data + PC on wifi,
  // which sit behind strict/symmetric NATs). Without TURN, cross-network joins
  // frequently fail. These are public/free servers.
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }

  room = joinRoom({ appId: APP_ID, rtcConfig }, code)

  ;[sendCtrl]     = room.makeAction('ctrl')
  ;[sendState]    = room.makeAction('state')
  ;[sendChat]     = room.makeAction('chat')
  ;[sendPlaylist] = room.makeAction('plist')
  ;[sendHello]    = room.makeAction('hello')

  const [, getCtrl]     = room.makeAction('ctrl')
  const [, getState]    = room.makeAction('state')
  const [, getChat]     = room.makeAction('chat')
  const [, getPlaylist] = room.makeAction('plist')
  const [, getHello]    = room.makeAction('hello')

  getCtrl((msg) => applyControl(msg))
  getState((s) => applySnapshot(s))
  getChat((m) => addChat(m.name, m.text))
  getPlaylist((pl) => { playlist = pl || []; renderPlaylist() })
  getHello((h, peerId) => {
    addChat('', `${h.name} joined`, true)
    // Existing members send the newcomer the current state
    setTimeout(() => sendState(snapshot(), peerId), 400)
  })

  room.onPeerJoin((peerId) => {
    updatePeerCount()
    setStatus('connected')
    showToast('🎉 A friend connected!')
  })
  room.onPeerLeave(() => {
    updatePeerCount()
  })

  // Announce ourselves shortly after joining
  setTimeout(() => {
    setStatus('connected')
    sendHello({ name: myName })
    addChat('', 'You joined as ' + myName, true)
  }, 700)
}

function updatePeerCount() {
  const n = room ? Object.keys(room.getPeers()).length + 1 : 1
  peerCount.textContent = n
}

function setStatus(state) {
  statusDot.className = 'dot ' + state
  statusText.textContent = state === 'connected' ? 'connected' : 'connecting…'
}

// ---------------------------------------------------------------------------
// Wire up UI
// ---------------------------------------------------------------------------
createBtn.addEventListener('click', () => enterRoom(genCode()))
joinBtn.addEventListener('click', () => {
  const code = (joinCodeInput.value || '').trim()
  if (!code) { showToast('Enter a room code'); return }
  enterRoom(code)
})
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click() })

leaveBtn.addEventListener('click', () => {
  if (room) room.leave()
  location.href = location.pathname
})

shareBtn.addEventListener('click', async () => {
  const url = location.origin + location.pathname + '?room=' + roomCodeLabel.textContent
  try {
    await navigator.clipboard.writeText(url)
    showToast('Invite link copied! 📋')
  } catch {
    prompt('Share this link with friends:', url)
  }
})

addForm.addEventListener('submit', (e) => {
  e.preventDefault()
  addItem(urlInput.value, titleInput.value)
  urlInput.value = ''
  titleInput.value = ''
})

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = chatInput.value.trim()
  if (!text) return
  addChat(myName, text)
  sendChat?.({ name: myName, text })
  chatInput.value = ''
})

resyncBtn.addEventListener('click', () => {
  // Ask peers for fresh state by re-announcing
  sendHello?.({ name: myName })
  showToast('Re-syncing…')
})

// Tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'))
    $('tab-' + tab.dataset.tab).classList.remove('hidden')
  })
})

// Auto-join from ?room= link
const params = new URLSearchParams(location.search)
const presetRoom = params.get('room')
if (presetRoom) {
  joinCodeInput.value = presetRoom.toUpperCase()
  nameInput.focus()
}

renderPlaylist()
