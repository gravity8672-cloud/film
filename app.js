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
const nameInput = $('nameInput'), joinCodeInput = $('joinCodeInput'), customCodeInput = $('customCodeInput')
const createBtn = $('createBtn'), joinBtn = $('joinBtn')
const roomCodeLabel = $('roomCodeLabel'), statusDot = $('statusDot'), statusText = $('statusText'), peerCount = $('peerCount')
const shareBtn = $('shareBtn'), leaveBtn = $('leaveBtn'), reconnectBtn = $('reconnectBtn')
const video = $('video'), ytContainer = $('ytContainer'), emptyState = $('emptyState'), playerWrap = $('playerWrap')
const nowPlaying = $('nowPlaying'), resyncBtn = $('resyncBtn'), autoSyncToggle = $('autoSyncToggle')
const addForm = $('addForm'), urlInput = $('urlInput'), titleInput = $('titleInput'), playlistEl = $('playlist')
const chatLog = $('chatLog'), chatForm = $('chatForm'), chatInput = $('chatInput')
const toast = $('toast')

// ---- State ----
let myName = 'Guest'
let myId = Math.random().toString(36).slice(2, 9)
let isHost = false          // room creator (or whoever takes control) drives playback
let hostId = null           // id of the current host that everyone follows
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
let currentRoomCode = null
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

// Clean a user-typed room code: uppercase letters/numbers only, max 12 chars.
function sanitizeCode(v) {
  return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

// Deterministic color per member id, so each name gets a stable dot color.
function colorFor(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h}, 70%, 58%)`
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

// Only the host may switch what everyone is watching.
function requestLoad(i) {
  if (!isHost) { showToast('🔒 Only the host can change the video'); return }
  loadItem(i)
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
      if (!autoSyncToggle.checked) return
      // Follow the host onto the right playlist item…
      if (msg.index >= 0 && msg.index !== currentIndex) { loadItem(msg.index, { broadcast: false }); return }
      // …then match the host's play/pause state and correct any drift.
      if (msg.paused) {
        if (!playerIsPaused()) playerPause()
      } else {
        if (playerIsPaused()) { playerSeek(msg.t); playerPlay() }
        else if (drift > 1.2) playerSeek(msg.t)
      }
    }
  } finally {
    setTimeout(() => { applyingRemote = false }, 120)
  }
}

// Heartbeat for drift correction (everyone sends; receivers self-correct)
setInterval(() => {
  // Only the host emits the heartbeat; everyone else follows it. The heartbeat
  // carries the host's play/pause state + current item so followers self-heal.
  if (!isHost || !mqttClient || currentIndex < 0) return
  sendCtrl({ kind: 'heartbeat', t: playerGetTime(), paused: playerIsPaused(), index: currentIndex })
}, 3000)

// ---------------------------------------------------------------------------
// Full-state sync (sent to newcomers)
// ---------------------------------------------------------------------------
function snapshot() {
  return {
    playlist,
    currentIndex,
    t: playerGetTime(),
    paused: playerIsPaused(),
    hostId
  }
}
function applySnapshot(s) {
  if (!s) return
  if (s.hostId) { hostId = s.hostId; updateHostUI() }
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
    li.querySelector('.pl-body').addEventListener('click', () => requestLoad(i))
    li.querySelector('.pl-index').addEventListener('click', () => requestLoad(i))
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
  if (currentIndex === -1 && isHost) loadItem(playlist.length - 1)
  showToast(isHost ? 'Added to playlist' : 'Added — the host can press it to play')
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
    const willTopic = APP_ID + '/' + roomCode
    try {
      client = mqtt.connect(url, {
        clientId: 'cs_' + myId, clean: true, keepalive: 30, reconnectPeriod: 5000, connectTimeout: 8000,
        // Last Will: if this client drops (tab closed, connection lost), the
        // broker auto-publishes this "bye" so others are notified immediately.
        will: {
          topic: willTopic,
          payload: JSON.stringify({ t: 'bye', _from: myId, name: myName }),
          qos: 0, retain: false
        }
      })
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
  mqttClient.on('offline', () => setStatus('connecting'))
  mqttClient.on('close', () => setStatus('connecting'))
  // On every (re)connect: re-subscribe (clean sessions don't auto-resub) and
  // re-announce so the room sees us and sends back the current state.
  mqttClient.on('connect', () => {
    setStatus('connected')
    try { mqttClient.subscribe(busTopic) } catch {}
    publishBus({ t: 'hello', name: myName })
  })

  setStatus('connected')
  publishBus({ t: 'hello', name: myName })
  // presence ping + prune
  setInterval(() => publishBus({ t: 'presence', name: myName }), 5000)
  setInterval(prunePeers, 5000)
}

// Reconnect on demand (button) or when the tab comes back to the foreground.
async function reconnectNow() {
  if (!currentRoomCode) return
  showToast('Reconnecting…')
  setStatus('connecting')
  try { if (mqttClient) mqttClient.end(true) } catch {}
  mqttClient = null
  peers = {}
  updatePeerCount()
  let ok = false
  try { ok = await connectBus(currentRoomCode) } catch { ok = false }
  if (ok) showToast('Reconnected ✅')
  else { setStatus('error'); showToast('Still offline — check your internet', 5000) }
}

// Browsers suspend background tabs and can silently drop the connection.
// When we come back to the foreground, make sure we're still connected.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentRoomCode) return
  if (!mqttClient || !mqttClient.connected) {
    reconnectNow()
  } else {
    // Connected but possibly stale — re-announce to re-sync.
    publishBus({ t: 'hello', name: myName })
  }
})
window.addEventListener('online', () => {
  if (currentRoomCode && (!mqttClient || !mqttClient.connected)) reconnectNow()
})

function publishBus(obj) {
  if (!mqttClient || !busTopic) return
  obj._from = myId
  if (isHost) obj.host = true   // tag every host message so followers know the source of truth
  try { mqttClient.publish(busTopic, JSON.stringify(obj)) } catch {}
}

function handleBus(m) {
  if (!m || m._from === myId) return
  if (m.t === 'bye') { handleBye(m); return }
  // Track who the host is. If someone else claims host while we thought we were,
  // step down so there's always exactly one source of truth.
  if (m.host) {
    if (hostId !== m._from) { hostId = m._from; updateHostUI() }
    if (isHost) { isHost = false; updateHostUI(); addChat('', '👑 ' + (m.name || 'Someone') + ' took over as host', true) }
  }
  const now = Date.now()
  if (m._from) {
    const known = !!peers[m._from]
    peers[m._from] = { name: m.name || (peers[m._from] && peers[m._from].name) || 'Guest', last: now }
    if (!known) {
      updatePeerCount()
      addChat('', '✅ ' + peers[m._from].name + ' joined the room', true)
      showToast('🎉 ' + peers[m._from].name + ' joined!')
      beep(700)
    } else {
      updatePeerCount()
    }
  }
  switch (m.t) {
    case 'hello':
      // newcomer announced themselves -> reply with presence; only the host
      // sends the authoritative playback snapshot so newcomers don't get conflicting state.
      publishBus({ t: 'presence', name: myName })
      if (isHost) setTimeout(() => publishBus({ t: 'state', to: m._from, snap: snapshot() }), 400)
      break
    case 'presence':
      break
    case 'ctrl':
      // Only obey control messages that come from the host.
      if (!isHost && m.host) applyControl(m.msg)
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

// A member left (sent explicitly on leave, or by the broker's Last Will).
function handleBye(m) {
  const p = peers[m._from]
  const name = (p && p.name) || m.name || 'Someone'
  if (p) { delete peers[m._from]; updatePeerCount() }
  addChat('', '👋 ' + name + ' left the room', true)
  showToast('👋 ' + name + ' left')
  beep(380)
}

function prunePeers() {
  const now = Date.now()
  for (const id in peers) {
    if (now - peers[id].last > 16000) {
      const name = peers[id].name
      delete peers[id]
      updatePeerCount()
      addChat('', '👋 ' + name + ' left the room', true)
      showToast('👋 ' + name + ' left')
      beep(380)
    }
  }
}

// Soft notification beep (Web Audio — no file needed).
let audioCtx = null
function beep(freq = 600, dur = 0.12) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.value = 0.06
    o.connect(g); g.connect(audioCtx.destination)
    o.start()
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur)
    o.stop(audioCtx.currentTime + dur)
  } catch {}
}

// ---- Typed senders used across the app ----
function sendCtrl(msg)      { if (isHost) publishBus({ t: 'ctrl', msg }) }   // only the host broadcasts playback control
function sendChat(o)        { publishBus({ t: 'chat', name: o.name, text: o.text }) }
function sendPlaylist(pl)   { publishBus({ t: 'plist', playlist: pl }) }
function sendHello()        { publishBus({ t: 'hello', name: myName }) }

function updatePeerCount() {
  peerCount.textContent = Object.keys(peers).length + 1
  renderMembers()
}

// Render the list of everyone in the room (self + connected peers).
function renderMembers() {
  const bar = $('membersBar')
  if (!bar) return
  const list = [{ id: myId, name: myName, me: true }]
  for (const id in peers) list.push({ id, name: peers[id].name || 'Guest' })
  bar.innerHTML = '<span class="members-label">👥 In this room:</span>' + list.map((m) => {
    const host = !!(hostId && m.id === hostId)
    return `<span class="member-chip${m.me ? ' me' : ''}${host ? ' host' : ''}">
       <span class="member-dot" style="background:${colorFor(m.id)}"></span>
       ${host ? '👑 ' : ''}${escapeHtml(m.name)}${m.me ? ' <em>(you)</em>' : ''}
     </span>`
  }).join('')
}

function setStatus(state) {
  statusDot.className = 'dot ' + state
  statusText.textContent = state === 'connected' ? 'connected' : (state === 'error' ? 'connection failed' : 'connecting…')
}

// ---------------------------------------------------------------------------
// Host controls (only the host can play / pause / seek / switch video)
// ---------------------------------------------------------------------------
function updateHostUI() {
  const note = $('hostNote')
  if (note) note.textContent = isHost ? "👑 You're the host — you control playback" : '🔒 The host controls playback'
  const tc = $('takeControlBtn')
  if (tc) tc.classList.toggle('hidden', isHost)
  // Followers get no native scrub/pause UI; the host keeps full controls.
  if (isHost) video.setAttribute('controls', '')
  else video.removeAttribute('controls')
  renderMembers()
}

// Any follower can claim control (also rescues a room whose host has left).
function takeControl() {
  if (isHost) return
  isHost = true
  hostId = myId
  updateHostUI()
  // Presence is now tagged host:true; immediately push state so others follow us.
  publishBus({ t: 'presence', name: myName })
  sendCtrl({ kind: 'heartbeat', t: playerGetTime(), paused: playerIsPaused(), index: currentIndex })
  addChat('', '👑 You took control of playback', true)
  showToast("You're the host now 👑")
}

// Followers: tapping the video only ever RESUMES playback (needed for mobile
// autoplay rules) — it can never pause, so it won't desync the room.
playerWrap.addEventListener('click', () => {
  if (!isHost && activeKind === 'video' && video.paused) playerPlay()
})

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------
async function enterRoom(code, asHost = false) {
  myName = (nameInput.value || '').trim() || 'Guest'
  code = code.toUpperCase()
  isHost = asHost
  if (isHost) hostId = myId
  currentRoomCode = code
  roomCodeLabel.textContent = code
  lobby.classList.add('hidden')
  roomEl.classList.remove('hidden')
  history.replaceState(null, '', '?room=' + code)
  updateHostUI()
  setStatus('connecting')

  let ok = false
  try { ok = await connectBus(code) } catch { ok = false }

  if (!ok) {
    setStatus('error')
    addChat('', '⚠️ Could not reach the sync service. Check your internet connection and reload. If you are on a restricted/work network, try a different network.', true)
    showToast('Could not connect — see chat', 6000)
    return
  }
  addChat('', 'You joined as ' + myName + (isHost ? ' 👑 (host — you control playback)' : ' (the host controls playback)'), true)
  renderMembers()
}

// ---------------------------------------------------------------------------
// Wire up UI
// ---------------------------------------------------------------------------
createBtn.addEventListener('click', () => {
  const custom = sanitizeCode(customCodeInput.value)
  enterRoom(custom || genCode(), true)   // creator is the host
})
joinBtn.addEventListener('click', () => {
  const code = sanitizeCode(joinCodeInput.value)
  if (!code) { showToast('Enter a room code'); return }
  enterRoom(code, false)                 // joiners follow the host
})
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click() })
customCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click() })

leaveBtn.addEventListener('click', () => {
  currentRoomCode = null
  if (mqttClient) {
    try { publishBus({ t: 'bye', name: myName }); mqttClient.end(true) } catch {}
  }
  location.href = location.pathname
})

reconnectBtn.addEventListener('click', () => reconnectNow())
$('takeControlBtn').addEventListener('click', takeControl)

// Only announce "bye" on an actual page unload (close/navigate away).
// We intentionally do NOT do this on tab-switch/visibility changes, so
// hopping to Spotify/Discord won't kick you out of the room.
window.addEventListener('beforeunload', () => {
  if (currentRoomCode) { try { publishBus({ t: 'bye', name: myName }) } catch {} }
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

// Lobby ambience: drifting sakura petals over the Lucy background.
;(function spawnPetals() {
  const lobbyEl = document.getElementById('lobby')
  if (!lobbyEl) return
  const layer = document.createElement('div')
  layer.className = 'petal-layer'
  lobbyEl.appendChild(layer)
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('span')
    p.className = 'petal'
    const size = 6 + Math.random() * 10
    p.style.left = (Math.random() * 100) + '%'
    p.style.width = size + 'px'
    p.style.height = size + 'px'
    p.style.animationDuration = (8 + Math.random() * 10) + 's'
    p.style.animationDelay = (-Math.random() * 12) + 's'
    p.style.opacity = (0.4 + Math.random() * 0.5).toFixed(2)
    layer.appendChild(p)
  }
})()

renderPlaylist()
