// ---------------------------------------------------------------------------
// CineSync — watch party.
//
// Sync transport: a lightweight public MQTT-over-WebSocket message bus.
// We only need to share tiny control messages (play/pause/seek/chat), NOT the
// video. Each viewer loads the movie from its own URL on their own connection.
// Routing those tiny messages through a public broker over wss:// works across
// ANY networks (mobile data + wifi + different countries) with no NAT/TURN
// problems and no peer-to-peer firewall issues. No backend, no accounts.
// ---------------------------------------------------------------------------

const APP_ID = 'cinesync/v2'

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
let myName = 'Guest'
let myId = Math.random().toString(36).slice(2, 9)
let playlist = []          // [{id, url, title, type}]
let currentIndex = -1
let applyingRemote = false  // guard against rebroadcast loops
let hls = null
let ytPlayer = null
let ytReady = false
let activeKind = null       // 'video' | 'youtube'

// ---- Transport (MQTT bus) ----
let mqttClient = null
let busTopic = null
let peers = {}              // id -> { name, last }

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
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
  if (broadcast) sendCtrl({ kind: 'load', index, t: 0 })
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
    sendCtrl({ kind: 'play', t: ytPlayer.getCurrentTime() })
  } else if (e.data === YT.PlayerState.PAUSED) {
    sendCtrl({ kind: 'pause', t: ytPlayer.getCurrentTime() })
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
video.addEventListener('play',  () => { if (!applyingRemote) sendCtrl({ kind: 'play',  t: video.currentTime }) })
video.addEventListener('pause', () => { if (!applyingRemote) sendCtrl({ kind: 'pause', t: video.currentTime }) })
video.addEventListener('seeked',() => { if (!applyingRemote) sendCtrl({ kind: 'seek',  t: video.currentTime }) })

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
  if (!mqttClient || currentIndex < 0 || playerIsPaused()) return
  sendCtrl({ kind: 'heartbeat', t: playerGetTime() })
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

function addItem(url, title) {
  url = url.trim()
  if (!url) return
  const type = detectType(url)
  if (type === 'youtube' && !ytIdFromUrl(url)) { showToast('Could not read that YouTube link.'); return }
  const item = { id: Math.random().toString(36).slice(2, 9), url, title: (title || '').trim() || guessTitle(url), type }
  playlist.push(item)
  renderPlaylist()
  sendPlaylist(playlist)
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
  sendPlaylist(playlist)
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
// Transport: load MQTT.js, connect to a public broker, pub/sub by room code
// ---------------------------------------------------------------------------
function loadMqttLib() {
  return new Promise((resolve, reject) => {
    if (window.mqtt) return resolve(window.mqtt)
    const cdns = [
      'https://cdn.jsdelivr.net/npm/mqtt@5/dist/mqtt.min.js',
      'https://unpkg.com/mqtt@5/dist/mqtt.min.js'
    ]
    let i = 0
    const tryNext = () => {
      if (i >= cdns.length) return reject(new Error('mqtt lib failed'))
      const s = document.createElement('script')
      s.src = cdns[i++]
      s.onload = () => resolve(window.mqtt)
      s.onerror = tryNext
      document.head.appendChild(s)
    }
    tryNext()
  })
}

function tryBroker(mqtt, url, roomCode) {
  return new Promise((resolve) => {
    let settled = false
    let client
    try {
      client = mqtt.connect(url, { clientId: 'cs_' + myId, clean: true, keepalive: 30, reconnectPeriod: 5000, connectTimeout: 8000 })
    } catch { return resolve(null) }
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { client.end(true) } catch {}; resolve(null) }
    }, 9000)
    client.on('connect', () => {
      if (settled) return
      settled = true; clearTimeout(timer); resolve(client)
    })
    client.on('error', () => {
      if (settled) return
      settled = true; clearTimeout(timer); try { client.end(true) } catch {}; resolve(null)
    })
  })
}

async function connectBus(roomCode) {
  const mqtt = await loadMqttLib()
  const brokers = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ]
  for (const url of brokers) {
    const client = await tryBroker(mqtt, url, roomCode)
    if (client) { mqttClient = client; setupBus(roomCode); return true }
  }
  return false
}

function setupBus(roomCode) {
  busTopic = APP_ID + '/' + roomCode
  mqttClient.subscribe(busTopic)
  mqttClient.on('message', (_t, payload) => {
    try { handleBus(JSON.parse(payload.toString())) } catch {}
  })
  mqttClient.on('reconnect', () => setStatus('connecting'))
  mqttClient.on('connect', () => { setStatus('connected'); publishBus({ t: 'hello', name: myName }) })
  mqttClient.on('close', () => setStatus('connecting'))

  setStatus('connected')
  publishBus({ t: 'hello', name: myName })
  // presence ping + prune
  setInterval(() => publishBus({ t: 'presence', name: myName }), 5000)
  setInterval(prunePeers, 5000)
}

function publishBus(obj) {
  if (!mqttClient || !busTopic) return
  obj._from = myId
  try { mqttClient.publish(busTopic, JSON.stringify(obj)) } catch {}
}

function handleBus(m) {
  if (!m || m._from === myId) return
  const now = Date.now()
  if (m._from) {
    const known = !!peers[m._from]
    peers[m._from] = { name: m.name || (peers[m._from] && peers[m._from].name) || 'Guest', last: now }
    if (!known) { updatePeerCount(); showToast('🎉 ' + peers[m._from].name + ' connected!') }
    else updatePeerCount()
  }
  switch (m.t) {
    case 'hello':
      addChat('', (m.name || 'Someone') + ' joined', true)
      publishBus({ t: 'presence', name: myName })
      // send current state to the newcomer
      setTimeout(() => publishBus({ t: 'state', to: m._from, snap: snapshot() }), 400)
      break
    case 'presence':
      break
    case 'ctrl':
      applyControl(m.msg)
      break
    case 'chat':
      addChat(m.name, m.text)
      break
    case 'plist':
      playlist = m.playlist || []
      renderPlaylist()
      break
    case 'state':
      if (m.to === myId) applySnapshot(m.snap)
      break
  }
}

function prunePeers() {
  const now = Date.now()
  let changed = false
  for (const id in peers) {
    if (now - peers[id].last > 16000) { delete peers[id]; changed = true }
  }
  if (changed) updatePeerCount()
}

// ---- Typed senders used across the app ----
function sendCtrl(msg)      { publishBus({ t: 'ctrl', msg }) }
function sendChat(o)        { publishBus({ t: 'chat', name: o.name, text: o.text }) }
function sendPlaylist(pl)   { publishBus({ t: 'plist', playlist: pl }) }
function sendHello()        { publishBus({ t: 'hello', name: myName }) }

function updatePeerCount() {
  peerCount.textContent = Object.keys(peers).length + 1
}

function setStatus(state) {
  statusDot.className = 'dot ' + state
  statusText.textContent = state === 'connected' ? 'connected' : (state === 'error' ? 'connection failed' : 'connecting…')
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------
async function enterRoom(code) {
  myName = (nameInput.value || '').trim() || 'Guest'
  code = code.toUpperCase()
  roomCodeLabel.textContent = code
  lobby.classList.add('hidden')
  roomEl.classList.remove('hidden')
  history.replaceState(null, '', '?room=' + code)
  setStatus('connecting')

  let ok = false
  try { ok = await connectBus(code) } catch { ok = false }

  if (!ok) {
    setStatus('error')
    addChat('', '⚠️ Could not reach the sync service. Check your internet connection and reload. If you are on a restricted/work network, try a different network.', true)
    showToast('Could not connect — see chat', 6000)
    return
  }
  addChat('', 'You joined as ' + myName, true)
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
  if (mqttClient) { try { mqttClient.end(true) } catch {} }
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
  sendChat({ name: myName, text })
  chatInput.value = ''
})

resyncBtn.addEventListener('click', () => {
  sendHello()
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
