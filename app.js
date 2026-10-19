/* Folder Player — saved playlists, an ambience track under the music, and an EQ. */
'use strict';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('fp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fp.' + k, JSON.stringify(v)); } catch {} },
};
const clean = n => n.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
const fmt = s => isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00';
const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB';
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const folderOK = !isIOS && 'webkitdirectory' in document.createElement('input');

let toastTimer;
function toast(msg, sticky) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.hidden = true, 3800);
}

const probe = document.createElement('audio');
const TYPES = {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',
               flac:'audio/flac',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',
               wma:'audio/x-ms-wma',aiff:'audio/aiff',aif:'audio/aiff'};
function playable(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const t = f.type || TYPES[ext] || '';
  if (!t) return true;
  return probe.canPlayType(t) !== '';
}
const isAudio = f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|caf)$/i.test(f.name);
const isPlaylistFile = f => /\.m3u8?$/i.test(f.name);

// ---------- storage (IndexedDB) ----------
// playlists {id, name, tracks: [trackId]} · tracks {id, name, type, size} · sounds {id, name, size, dur}
// files: the audio itself, keyed 't<id>' for tracks and 's<id>' for ambience sounds
const db = (() => {
  let conn;
  const open = () => conn ||= new Promise((ok, bad) => {
    const r = indexedDB.open('folder-player', 1);
    r.onupgradeneeded = () => {
      for (const s of ['playlists', 'tracks', 'sounds']) r.result.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
      r.result.createObjectStore('files');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  // One transaction; resolves with fn's return value (a request's result once committed).
  async function tx(stores, mode, fn) {
    const d = await open();
    return new Promise((ok, bad) => {
      const t = d.transaction(stores, mode), out = fn(t);
      t.oncomplete = () => ok(out instanceof IDBRequest ? out.result : out);
      t.onerror = t.onabort = () => bad(t.error || new Error('Storage failed'));
    });
  }
  return {
    all: s => tx(s, 'readonly', t => t.objectStore(s).getAll()),
    file: key => tx('files', 'readonly', t => t.objectStore('files').get(key)),
    put: (s, v) => tx(s, 'readwrite', t => t.objectStore(s).put(v)),
    add: (s, meta, blob, prefix) => tx([s, 'files'], 'readwrite', t => {
      const r = t.objectStore(s).add(meta);
      r.onsuccess = () => t.objectStore('files').put(blob, prefix + r.result);
      return r;
    }),
    del: (s, ids, prefix) => tx([s, 'files'], 'readwrite', t => {
      for (const id of ids) { t.objectStore(s).delete(id); if (prefix) t.objectStore('files').delete(prefix + id); }
    }),
  };
})();
let dbOK = 'indexedDB' in window;
let tempId = -1; // ids for things that couldn't be saved; they last until the app closes

// ---------- playlists ----------
const a = $('a'), list = $('list'), footer = $('foot');
const nowEl = $('now'), seek = $('seek'), curEl = $('cur'), durEl = $('dur'), playBtn = $('play');
let lists = [];       // [{id, name, tracks: [{id, name, type, size, blob, temp}], temp}]
let view = null;      // playlist on screen
let playing = null;   // playlist the queue comes from
let order = [], pos = -1, shuffle = store.get('shuffle', false), seeking = false, pendingSeek = 0, editing = false, fails = 0;
const current = () => order[pos] || null;

async function loadLibrary() {
  try {
    const [pls, trs] = await Promise.all([db.all('playlists'), db.all('tracks')]);
    const byId = new Map(trs.map(t => [t.id, t]));
    lists = pls.map(p => ({ id: p.id, name: p.name, tracks: p.tracks.map(id => byId.get(id)).filter(Boolean) }));
  } catch { dbOK = false; }
}

// Blob handles are cheap (the audio stays on disk), so a playlist's are fetched up
// front. That keeps play() inside the tap, which iOS insists on.
function blobs(pl) {
  return pl.ready ||= Promise.all(pl.tracks.map(async t => { if (!t.blob) t.blob = await db.file('t' + t.id).catch(() => null); }));
}

function savePl(pl) {
  if (pl.id < 0 || !lists.includes(pl)) return Promise.resolve();
  return db.put('playlists', { id: pl.id, name: pl.name, tracks: pl.tracks.filter(t => !t.temp).map(t => t.id) }).catch(() => {});
}

// Files from the picker. Playlist files (.m3u/.m3u8, e.g. from Audio Grabber) become playlists of the
// picked songs they list. Without any, a folder pick makes one playlist per folder, and plain file picks
// make one playlist (or join `target`).
async function addFiles(picked, target) {
  picked = [...picked];
  const files = picked.filter(isAudio), listFiles = picked.filter(isPlaylistFile);
  if (!files.length) return toast('No audio files in that selection.');
  const groups = listFiles.length && !target ? await playlistGroups(listFiles, files) : folderGroups(files);
  if (!groups.length) return toast("The playlist files don't list any of the chosen songs.");
  // One item per song, even when it's in several playlists, so it's stored on the device only once.
  const items = new Map();
  const itemFor = f => items.get(f) || items.set(f, { id: tempId--, name: f.name, type: f.type, size: f.size, blob: f, temp: true }).get(f);
  const fresh = [];
  for (const { name, songs } of groups) {
    const pl = target || { id: tempId--, name: name || 'Playlist ' + (lists.length + 1), tracks: [], ready: null };
    if (!target) lists.push(pl);
    const plItems = songs.map(itemFor);
    pl.tracks.push(...plItems);
    fresh.push([pl, plItems]);
  }
  const bad = files.filter(f => !playable(f)).length, w = $('warn');
  w.hidden = !bad;
  if (bad) w.textContent = bad + ' of ' + files.length + " files use a codec this browser can't decode (usually Ogg or Opus). Convert them to MP3 or M4A, or play those in VLC.";

  view = fresh[0][0]; editing = false;
  render();
  if (!target) { const [pl, items] = fresh[0]; queue(pl, items[0]); load(items[0]); start(); }
  if (listFiles.length && !target) toast(`${groups.length} playlists from playlist files.`);
  for (const [pl, items] of fresh) persist(pl, items);
}

// [{name, songs}], one per folder, songs sorted by name.
function folderGroups(files) {
  const groups = new Map();
  for (const f of files) {
    const p = f.webkitRelativePath || '', dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return [...groups].map(([dir, songs]) => ({
    name: dir ? dir.split('/').pop() : '',
    songs: songs.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })),
  }));
}

// [{name, songs}], one per playlist file, in its order. Its lines (apart from # comments) are song paths,
// relative to the playlist file; songs it lists that weren't picked are left out. A path that doesn't fit
// (e.g. on iPhone, where picked files have no folders) is matched by file name instead.
async function playlistGroups(listFiles, files) {
  const key = p => p.replace(/\\/g, '/').toLowerCase();
  const byPath = new Map(files.map(f => [key(f.webkitRelativePath || f.name), f]));
  const byName = new Map();
  for (const f of files) byName.set(f.name.toLowerCase(), byName.has(f.name.toLowerCase()) ? null : f);  // null: not unique
  const groups = [];
  for (const list of listFiles) {
    const rel = list.webkitRelativePath || '';
    const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).split('/') : [];
    const songs = [];
    for (let line of (await list.text()).split(/\r?\n/)) {
      line = line.trim().replace(/^﻿/, '');
      if (!line || line.startsWith('#')) continue;
      const parts = [...base];
      for (const part of key(line).split('/')) {
        if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
      }
      const f = byPath.get(parts.join('/')) || byName.get(key(line).split('/').pop());
      if (f && !songs.includes(f)) songs.push(f);
    }
    if (songs.length) groups.push({ name: list.name.replace(/\.m3u8?$/i, ''), songs });
  }
  return groups;
}

// Tracks no playlist uses any more. A song can be in several playlists but is stored only once.
const unused = tracks => tracks.filter(t => !t.temp && !lists.some(pl => pl.tracks.includes(t)));

// Copies new tracks into storage one at a time (in the background, in order).
let saving = Promise.resolve();
function persist(pl, items) {
  saving = saving.then(async () => {
    if (!dbOK) { pl.temp = true; renderBar(); return toast("This browser won't save files, so the playlist lasts until you close the app."); }
    try { if (pl.id < 0) pl.id = await db.put('playlists', { name: pl.name, tracks: [] }); }
    catch { pl.temp = true; renderBar(); return; }
    let n = 0, full = false;
    for (const t of items) {
      if (!lists.includes(pl) || !pl.tracks.includes(t)) continue;
      if (!t.temp) { n++; continue; }  // already saved for another playlist
      toast(`Saving to this device… ${++n} of ${items.length}`, true);
      if (full) continue;
      try { t.id = await db.add('tracks', { name: t.name, type: t.type, size: t.size }, t.blob, 't'); t.temp = false; }
      catch { full = true; }
    }
    await savePl(pl);
    if (!lists.includes(pl)) db.del('tracks', unused(items).map(t => t.id), 't').catch(() => {});
    toast(full ? "Storage is full. Some tracks will only play until you close the app."
      : `Saved “${pl.name}” on this device.` + (/^Playlist \d+$/.test(pl.name) ? ' Tap its name to rename it.' : ''));
    navigator.storage?.persist?.().catch(() => {});
    renderBar();
    remember(true);
  });
}

async function deletePl(pl) {
  const shared = pl.tracks.filter(t => lists.some(other => other !== pl && other.tracks.includes(t))).length;
  if (!confirm(`Delete “${pl.name}” and its ${pl.tracks.length - shared} tracks from this device?`
    + (shared ? ` ${shared} more stay, because other playlists have them too.` : ''))) return;
  if (playing === pl) stopMusic();
  lists.splice(lists.indexOf(pl), 1);
  view = lists[0] || null; editing = false;
  render();
  if (pl.id > 0) await db.del('playlists', [pl.id]).catch(() => {});
  await db.del('tracks', unused(pl.tracks).map(t => t.id), 't').catch(() => {});
}

async function removeTrack(pl, t) {
  if (playing === pl) {
    if (current() === t) stopMusic();
    else { const cur = current(); order = order.filter(x => x !== t); pos = order.indexOf(cur); }
  }
  pl.tracks.splice(pl.tracks.indexOf(t), 1);
  render();
  await savePl(pl);
  if (unused([t]).length) db.del('tracks', [t.id], 't').catch(() => {});
}

// Turns the playlist's tab into a text field: Enter or tapping away saves, Esc cancels.
function renamePl(pl) {
  const tab = $('tabs').querySelector('.tab.on');
  if (!tab) return;
  const input = document.createElement('input');
  input.className = 'tab rename'; input.value = pl.name; input.maxLength = 40;
  input.enterKeyHint = 'done'; input.setAttribute('aria-label', 'Playlist name');
  tab.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== pl.name) { pl.name = name; savePl(pl); session(); }
    renderTabs();
  };
  input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

function render() { renderTabs(); renderBar(); renderList(); }

function renderTabs() {
  const nav = $('tabs');
  nav.hidden = !lists.length; nav.textContent = '';
  for (const pl of lists) {
    const b = document.createElement('button');
    b.className = 'tab' + (pl === view ? ' on' : '') + (pl === playing ? ' playing' : '');
    b.textContent = pl.name;
    // Tapping the playlist you're already on renames it; the pencil says so.
    if (pl === view) {
      b.insertAdjacentHTML('beforeend', '<svg class="pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>');
      b.setAttribute('aria-label', pl.name + ', rename');
    }
    b.onclick = () => {
      if (pl === view) return renamePl(pl);
      view = pl; editing = false; $('warn').hidden = true; blobs(pl); render();
    };
    nav.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'tab add'; add.textContent = '+ New';
  add.onclick = () => pickMusic(null);
  nav.appendChild(add);
  nav.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderBar() {
  $('empty').hidden = !!lists.length;
  $('plbar').hidden = !view;
  if (!view) return;
  const bytes = view.tracks.reduce((s, t) => s + (t.size || 0), 0), n = view.tracks.length;
  const unsaved = view.temp || view.tracks.some(t => t.temp);
  $('plinfo').textContent = `${n} track${n === 1 ? '' : 's'} · ${size(bytes)}` + (unsaved ? ' · not saved yet' : '');
  $('plAdd').hidden = editing;
  $('plRename').hidden = $('plDelete').hidden = !editing;
  $('plEdit').textContent = editing ? 'Done' : 'Edit';
  $('plEdit').classList.toggle('act', editing);
}

function renderList() {
  list.textContent = '';
  if (!view) return;
  view.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="n"></span><span class="t"></span>';
    li.firstChild.textContent = i + 1;
    li.lastChild.textContent = clean(t.name);
    if (!playable(t)) li.classList.add('bad');
    if (editing) {
      const x = document.createElement('button');
      x.className = 'rm'; x.textContent = 'Remove';
      x.onclick = e => { e.stopPropagation(); removeTrack(view, t); };
      li.appendChild(x);
    }
    li.onclick = () => { if (!editing) tapTrack(view, t); };
    list.appendChild(li);
  });
  if (!view.tracks.length) {
    const li = document.createElement('li');
    li.className = 'none'; li.textContent = 'No tracks. Tap Add to put some in.';
    list.appendChild(li);
  }
  paintList();
}

function paintList() {
  const t = current();
  [...list.children].forEach((li, i) => li.classList.toggle('on', view === playing && view.tracks[i] === t));
}

// ---------- player ----------
function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function queue(pl, t) {
  if (playing !== pl) { playing = pl; renderTabs(); }
  order = shuffle ? shuffled([...pl.tracks]) : [...pl.tracks];
  pos = order.indexOf(t);
}

function tapTrack(pl, t) {
  const go = () => {
    if (!t.blob) return toast('That file is missing from this device. Remove it and add it again.');
    queue(pl, t); load(t); start();
  };
  t.blob ? go() : blobs(pl).then(go);
}

function load(t, at = 0) {
  pos = order.indexOf(t);
  if (a.src) URL.revokeObjectURL(a.src);
  a.src = URL.createObjectURL(t.blob);
  pendingSeek = at;
  nowEl.innerHTML = '<b></b>';
  nowEl.firstChild.textContent = clean(t.name);
  curEl.textContent = fmt(at); seek.value = 0;
  $('music').hidden = false; footer.classList.add('has-music');
  paintList();
  if (view === playing) list.children[view.tracks.indexOf(t)]?.scrollIntoView({ block: 'nearest' });
  session(); remember(true);
}

function start() {
  if (eq.routed) audio(); else eqRoute();
  a.play().catch(() => {});
}

function stopMusic() {
  a.pause();
  if (a.src) URL.revokeObjectURL(a.src);
  a.removeAttribute('src'); a.load();
  const was = playing;
  playing = null; order = []; pos = -1;
  $('music').hidden = true; footer.classList.remove('has-music');
  store.set('resume', null);
  if (was) renderTabs();
  paintList(); session();
}

const step = d => {
  if (!order.length) return;
  let p = pos + d; if (p >= order.length) p = 0; if (p < 0) p = order.length - 1;
  const t = order[p];
  if (!t.blob) { pos = p; return fails++ < order.length ? step(d) : stopMusic(); }
  load(t); start();
};

let lastSave = 0;
function remember(now) {
  const t = current();
  if (!t || !playing || (!now && Date.now() - lastSave < 5000)) return;
  lastSave = Date.now();
  store.set('resume', { pl: playing.id, t: t.id, at: a.currentTime || pendingSeek || 0 });
}

$('next').onclick = () => step(1);
$('prev').onclick = () => a.currentTime > 3 ? a.currentTime = 0 : step(-1);
playBtn.onclick = () => { held = null; a.paused ? start() : a.pause(); };
const paintShuffle = () => $('shuf').classList.toggle('act', shuffle);
$('shuf').onclick = () => {
  shuffle = !shuffle; store.set('shuffle', shuffle); paintShuffle();
  if (!playing) return;
  const cur = current();
  order = shuffle ? shuffled([...playing.tracks]) : [...playing.tracks];
  pos = order.indexOf(cur);
};

a.onended = () => step(1);
a.onplay = () => {
  playBtn.textContent = 'Pause'; fails = 0;
  if (eq.routed && ctx.state !== 'running') ctx.resume().catch(() => {});
  session(); position();
};
a.onpause = () => { playBtn.textContent = 'Play'; session(); position(); remember(true); relax(); };
a.onloadedmetadata = a.ondurationchange = () => {
  if (pendingSeek) { a.currentTime = Math.max(0, Math.min(pendingSeek, a.duration - 1)); pendingSeek = 0; }
  durEl.textContent = fmt(a.duration); position();
};
a.onerror = () => {
  const t = current();
  if (!a.getAttribute('src') || !t) return;
  nowEl.innerHTML = '<b></b> — format not supported';
  nowEl.firstChild.textContent = 'Skipped ' + clean(t.name);
  if (++fails < order.length) setTimeout(() => step(1), 900);
};
a.ontimeupdate = () => {
  if (seeking) return;
  curEl.textContent = fmt(a.currentTime); durEl.textContent = fmt(a.duration);
  seek.value = a.duration ? a.currentTime / a.duration * 1000 : 0;
  remember();
};
a.onseeked = () => position();
seek.oninput = () => { seeking = true; curEl.textContent = fmt(seek.value / 1000 * a.duration); };
seek.onchange = () => { a.currentTime = seek.value / 1000 * a.duration; seeking = false; };

// ---------- lock screen / headphone controls ----------
let held = null; // what a lock-screen pause stopped, so play brings back the same things
function pauseAll() {
  held = { music: !a.paused, amb: ambOn };
  a.pause();
  if (ambOn) ambStop();
  session();
}
function playAll() {
  const h = held && (held.music || held.amb) ? held : { music: !!current(), amb: !current() && !!ambSel };
  held = null;
  if (h.music && current()) start();
  if (h.amb && ambSel) ambStart(ambSel);
}

function session() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession, t = current(), amb = ambOn && ambSel ? ambSel.name : '';
  const artwork = [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
  if (t) ms.metadata = new MediaMetadata({ title: clean(t.name), artist: playing.name + (amb ? ' · ' + amb : ''), artwork });
  else if (amb) ms.metadata = new MediaMetadata({ title: amb, artist: 'Ambience', artwork });
  ms.playbackState = !a.paused || ambOn ? 'playing' : 'paused';
}
function position() {
  try {
    if (a.duration > 0 && isFinite(a.duration))
      navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: 1 });
  } catch {}
}
if ('mediaSession' in navigator) {
  const on = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
  on('play', playAll);
  on('pause', pauseAll);
  on('nexttrack', () => step(1));
  on('previoustrack', () => step(-1));
  on('seekto', d => { a.currentTime = d.seekTime; position(); });
}

// ---------- audio engine (Web Audio) ----------
// Music plays straight from the <audio> element until the EQ is first switched on;
// only then is it routed through Web Audio (it stays routed until the app reloads).
let ctx = null;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.onstatechange = () => { if (ctx.state !== 'running' && needed() && !document.hidden) ctx.resume().catch(() => {}); };
  }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}
const needed = () => ambOn || (eq.routed && !a.paused);
function relax() { // let the audio engine sleep once nothing is using it
  setTimeout(() => { if (ctx && ctx.state === 'running' && !needed()) ctx.suspend().catch(() => {}); }, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ctx && needed() && ctx.state !== 'running') ctx.resume().catch(() => {});
});

// ---------- equalizer ----------
const BANDS = [[60, 'peaking', '60'], [170, 'peaking', '170'], [450, 'peaking', '450'],
               [1200, 'peaking', '1.2k'], [3500, 'peaking', '3.5k'], [10000, 'highshelf', '10k']];
const PRESETS = { Flat: [0, 0, 0, 0, 0, 0], Bass: [6, 4, 1, 0, 0, 0], Treble: [0, 0, 0, 1, 4, 6],
                  Vocal: [-2, -1, 2, 4, 3, 0], Loudness: [5, 2, 0, -1, 2, 5], Soft: [-1, 0, 0, 0, -2, -4] };
const Q = 0.9;
const saved = store.get('eq', {});
const eq = { on: !!saved.on, gains: Array.isArray(saved.gains) ? saved.gains : [...PRESETS.Flat], routed: false, pre: null, nodes: null };
const saveEq = () => store.set('eq', { on: eq.on, gains: eq.gains });

function eqNodes() {
  if (eq.nodes) return;
  const c = audio();
  eq.pre = c.createGain();
  eq.nodes = BANDS.map(([f, type]) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = Q; return n; });
  eq.nodes.reduce((prev, n) => { prev.connect(n); return n; }, eq.pre).connect(c.destination);
  eqApply();
}
// Routes the music through the EQ, but only once the engine is actually running;
// routing into a stalled engine would silence the music.
function eqRoute() {
  if (!eq.on || eq.routed) return;
  const c = audio();
  const go = () => {
    if (eq.routed || c.state !== 'running') return;
    eqNodes();
    try { c.createMediaElementSource(a).connect(eq.pre); eq.routed = true; } catch {}
  };
  c.state === 'running' ? go() : c.resume().then(go, () => {});
}
function eqApply() {
  if (!eq.nodes) return;
  const g = eq.on ? eq.gains : eq.gains.map(() => 0), t = ctx.currentTime;
  eq.nodes.forEach((n, i) => n.gain.setTargetAtTime(g[i], t, 0.03));
  // Pull the level down by the biggest boost so boosted bands don't clip.
  eq.pre.gain.setTargetAtTime(Math.pow(10, -Math.max(0, ...g) / 20), t, 0.03);
}

// Biquad magnitude in dB (RBJ cookbook, as Web Audio implements it), for the curve.
function biquadDb(type, f0, gain, f, sr = 48000) {
  const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * f0 / sr, cs = Math.cos(w0), sn = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') {
    const al = sn / (2 * Q);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    const s = type === 'lowshelf' ? 1 : -1, sq = 2 * Math.sqrt(A) * sn / Math.SQRT2;
    b0 = A * ((A + 1) - s * (A - 1) * cs + sq); b1 = 2 * s * A * ((A - 1) - s * (A + 1) * cs); b2 = A * ((A + 1) - s * (A - 1) * cs - sq);
    a0 = (A + 1) + s * (A - 1) * cs + sq; a1 = -2 * s * ((A - 1) + s * (A + 1) * cs); a2 = (A + 1) + s * (A - 1) * cs - sq;
  }
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2, dr = a0 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

function drawCurve() {
  const cv = $('eqCurve'), w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const y = db => h / 2 - db / 15 * (h / 2 - 8);
  g.lineWidth = 1;
  for (const d of [-12, -6, 0, 6, 12]) {
    g.strokeStyle = d ? '#232b37' : '#36414f';
    g.beginPath(); g.moveTo(0, y(d)); g.lineTo(w, y(d)); g.stroke();
  }
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const f = 20 * Math.pow(1000, x / w);
    const db = BANDS.reduce((s, [f0, type], i) => s + biquadDb(type, f0, eq.gains[i], f), 0);
    x ? g.lineTo(x, y(db)) : g.moveTo(x, y(db));
  }
  g.strokeStyle = eq.on ? '#6fd3b8' : '#5d6878'; g.lineWidth = 2; g.stroke();
}

function buildEq() {
  const host = $('eqBands');
  BANDS.forEach(([, , label], i) => {
    const row = document.createElement('label');
    row.className = 'band';
    row.innerHTML = `<span>${label}</span><input type="range" min="-12" max="12" step="1"><output></output>`;
    const input = row.querySelector('input');
    input.setAttribute('aria-label', label + ' Hz');
    input.oninput = () => {
      eq.gains[i] = +input.value;
      if (!eq.on) eqToggle(true); else { eqApply(); paintEq(); }
      saveEq();
    };
    host.appendChild(row);
  });
  const pre = $('eqPresets');
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = name; b.dataset.p = name;
    b.onclick = () => { eq.gains = [...PRESETS[name]]; saveEq(); eq.on ? (eqApply(), paintEq()) : eqToggle(true); };
    pre.appendChild(b);
  }
}

function paintEq() {
  const match = Object.keys(PRESETS).find(k => PRESETS[k].every((v, i) => v === eq.gains[i]));
  [...$('eqPresets').children].forEach(b => b.classList.toggle('act', eq.on && b.dataset.p === match));
  [...$('eqBands').children].forEach((row, i) => {
    row.querySelector('input').value = eq.gains[i];
    row.querySelector('output').textContent = (eq.gains[i] > 0 ? '+' : '') + eq.gains[i] + ' dB';
  });
  $('eqTog').setAttribute('aria-checked', eq.on);
  $('eqSheet').classList.toggle('eq-off', !eq.on);
  $('eqOpen').classList.toggle('act', eq.on);
  drawCurve();
}

function eqToggle(on) {
  eq.on = on; saveEq();
  if (on) { eqNodes(); eqRoute(); }
  eqApply(); paintEq();
}
$('eqTog').onclick = () => eqToggle(!eq.on);
$('eqOpen').onclick = () => { openSheet('eqSheet'); requestAnimationFrame(drawCurve); };

// ---------- ambience ----------
const ICONS = {
  rain: 'M6 14a3.5 3.5 0 0 1 .5-6.96A5 5 0 0 1 16 6.5a3.75 3.75 0 0 1 2 7.5zM8 17.5l-1 2.5M12 17.5l-1 2.5M16 17.5l-1 2.5',
  car: 'M3 17v-3.5l2.6-4h10.3l2.6 4H21V17zM9 17.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0zM18.5 17.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0zM8 3l-.8 2.5M12 3l-.8 2.5M16 3l-.8 2.5',
  storm: 'M6 14a3.5 3.5 0 0 1 .5-6.96A5 5 0 0 1 16 6.5a3.75 3.75 0 0 1 2 7.5zM12.5 15.5l-2 3.5h3l-2 3.5',
  waves: 'M2 7c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 17c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2',
  wind: 'M3 8h10a2.5 2.5 0 1 0-2.5-2.5M3 12h15a3 3 0 1 1-3 3M3 16h6',
  birds: 'M2.5 11c1.5-1.5 3-1.5 4.5 0 1.5-1.5 3-1.5 4.5 0M12.5 6.5c1.2-1.2 2.4-1.2 3.6 0 1.2-1.2 2.4-1.2 3.6 0M10 17c1-1 2-1 3 0 1-1 2-1 3 0',
  stream: 'M12 3.5c3 4 5.5 7 5.5 10.5a5.5 5.5 0 0 1-11 0c0-3.5 2.5-6.5 5.5-10.5z',
  fire: 'M12 3c.5 3.5 5 5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1 2.6 2 3 0-3 .2-5.5.5-8z',
  night: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  brown: 'M2 12h2.5l1.5-4 2 9 2-12 2 13 2-9 1.5 5 1.5-2H22',
  file: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
};
const BUILTIN = [['rain', 'Rain'], ['car', 'Car rain'], ['storm', 'Storm'], ['waves', 'Waves'], ['wind', 'Wind'], ['birds', 'Birds'],
                 ['stream', 'Stream'], ['fire', 'Fire'], ['night', 'Night'], ['brown', 'Brown noise']]
  .map(([id, name]) => ({ key: 'b:' + id, kind: 'synth', id, name, icon: ICONS[id] }));
let bundled = [], mine = [];
const allSounds = () => [...BUILTIN, ...bundled, ...mine];

const FADE = 0.8, SR = 44100;
let master = null, voice = null, ambOn = false, ambSel = null, ambJob = 0, ambBusy = null;
let level = store.get('ambLevel', 50);
const gainOf = v => 1.5 * (v / 100) ** 2;

// A few seconds of silence on a plain <audio> element, played whenever ambience is on.
// On iOS a playing media element is what keeps Web Audio going with the screen locked
// and the ringer switch on silent.
function silence() {
  const rate = 8000, n = rate * 10, v = new DataView(new ArrayBuffer(44 + n));
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([v.buffer], { type: 'audio/wav' }));
}
const SILENCE = silence();
const keep = new Audio(SILENCE); keep.loop = true;
// Long sound files stream through this element instead of being decoded into memory.
const ambEl = new Audio(); ambEl.loop = true;
let ambGain = null, ambPrimed = false;

// Must run inside a tap: iOS only starts audio from a user gesture.
function unlock() {
  const c = audio();
  if (!master) {
    master = c.createGain(); master.gain.value = gainOf(level); master.connect(c.destination);
    ambGain = c.createGain(); ambGain.gain.value = 0; ambGain.connect(master);
    c.createMediaElementSource(ambEl).connect(ambGain);
  }
  keep.play().catch(() => {});
  if (!ambPrimed) { ambPrimed = true; ambEl.src = SILENCE; ambEl.play().then(() => ambEl.pause(), () => {}); }
}

function fade(g, from, to) {
  const p = g.gain, t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(from ?? p.value, t);
  p.linearRampToValueAtTime(to, t + FADE);
}

function bufferVoice(buf) {
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; src.loop = true;
  src.connect(g).connect(master);
  fade(g, 0, 1); src.start();
  return { stop() { fade(g, null, 0); setTimeout(() => { try { src.stop(); } catch {} g.disconnect(); }, FADE * 1000 + 100); } };
}

function streamVoice(blob) {
  const url = URL.createObjectURL(blob);
  ambEl.src = url;
  const done = () => { if (ambEl.src === url) { ambEl.pause(); ambEl.removeAttribute('src'); } URL.revokeObjectURL(url); };
  return ambEl.play().then(() => {
    fade(ambGain, 0, 1);
    return { stream: true, stop(now) { if (now) return done(); fade(ambGain, null, 0); setTimeout(done, FADE * 1000 + 100); } };
  }, err => { done(); throw err; });
}

// Built-in sounds are rendered in a worker (or here, if workers can't start, e.g. file://).
let worker, jobs = 0, synthScript;
const pending = new Map(), pcm = new Map();
function onMainThread(id) {
  synthScript ||= new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'synth.js'; s.onload = ok; s.onerror = bad;
    document.head.appendChild(s);
  });
  return synthScript.then(() => new Promise(r => setTimeout(r, 30))).then(() => window.AmbienceSynth.render(id, SR));
}
function renderPCM(id) {
  if (!pcm.has(id)) {
    if (worker === undefined) {
      try {
        worker = new Worker('synth.js');
        worker.onmessage = e => {
          const p = pending.get(e.data.job); pending.delete(e.data.job);
          e.data.error ? p.bad(new Error(e.data.error)) : p.ok(e.data.ch);
        };
        worker.onerror = e => {
          e.preventDefault(); worker = null;
          for (const p of pending.values()) onMainThread(p.id).then(p.ok, p.bad);
          pending.clear();
        };
      } catch { worker = null; }
    }
    pcm.set(id, worker
      ? new Promise((ok, bad) => { const job = ++jobs; pending.set(job, { ok, bad, id }); worker.postMessage({ job, id, sr: SR }); })
      : onMainThread(id));
    pcm.get(id).catch(() => pcm.delete(id));
  }
  return pcm.get(id);
}

// Resolves after metadata loads with the duration in seconds (0 if unknown).
function duration(blob) {
  return new Promise(ok => {
    const el = new Audio(), url = URL.createObjectURL(blob);
    const done = d => { clearTimeout(timer); URL.revokeObjectURL(url); el.removeAttribute('src'); ok(d); };
    const timer = setTimeout(() => done(0), 4000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(0);
    el.src = url;
  });
}

const buffers = new Map(); // decoded loops, most recent last
async function sourceFor(it) {
  if (buffers.has(it.key)) { const b = buffers.get(it.key); buffers.delete(it.key); buffers.set(it.key, b); return b; }
  let buf;
  if (it.kind === 'synth') {
    const [l, r] = await renderPCM(it.id);
    pcm.delete(it.id);
    buf = ctx.createBuffer(2, l.length, SR);
    buf.getChannelData(0).set(l); buf.getChannelData(1).set(r);
  } else {
    const blob = it.blob || (it.kind === 'mine' ? await db.file('s' + it.id) : await fetch(it.url).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); }));
    if (!blob) throw new Error('missing');
    const dur = it.dur ?? await duration(blob);
    // Short clips are decoded so they loop without a gap; long ones stream.
    if (dur ? dur > 150 : blob.size > 2.5e6) return blob;
    buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  }
  buffers.set(it.key, buf);
  while (buffers.size > 3) buffers.delete(buffers.keys().next().value);
  return buf;
}

async function startVoice() {
  const job = ++ambJob, it = ambSel;
  ambBusy = it.key; paintAmb();
  try {
    const src = await sourceFor(it);
    if (job !== ambJob) return;
    const old = voice;
    if (src instanceof AudioBuffer) { voice = bufferVoice(src); old?.stop(); }
    else { old?.stop(true); voice = null; voice = await streamVoice(src); if (job !== ambJob) { voice.stop(); voice = null; } }
  } catch {
    if (job === ambJob) { ambOn = false; keep.pause(); toast(`Couldn't play ${it.name}.`); session(); }
  } finally {
    if (ambBusy === it.key) ambBusy = null;
    paintAmb();
  }
}

function ambStart(it) {
  unlock(); held = null;
  ambSel = it; ambOn = true;
  store.set('amb', it.key);
  paintAmb(); session();
  startVoice();
}

function ambStop() {
  ambOn = false; ambJob++;
  voice?.stop(); voice = null;
  keep.pause();
  paintAmb(); session(); relax();
}

function paintAmb() {
  $('ambName').textContent = ambSel ? ambSel.name : 'None';
  $('ambOpen').classList.toggle('busy', !!ambBusy);
  $('ambTog').setAttribute('aria-checked', ambOn);
  for (const el of document.querySelectorAll('[data-key]')) {
    el.classList.toggle('on', ambOn && ambSel?.key === el.dataset.key);
    el.classList.toggle('busy', ambBusy === el.dataset.key);
  }
}

function tile(it) {
  const b = document.createElement('button');
  b.className = 'tile'; b.dataset.key = it.key;
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${it.icon}"/></svg><span></span>`;
  b.lastChild.textContent = it.name;
  b.onclick = () => ambOn && ambSel?.key === it.key ? ambStop() : ambStart(it);
  return b;
}

function renderSounds() {
  const grid = $('builtins');
  grid.textContent = '';
  for (const it of [...BUILTIN, ...bundled]) grid.appendChild(tile(it));
  const ul = $('mine');
  ul.textContent = '';
  $('mineEmpty').hidden = mine.length > 0;
  for (const it of mine) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'pickit'; b.dataset.key = it.key;
    b.innerHTML = '<span></span><small></small>';
    b.firstChild.textContent = it.name;
    b.lastChild.textContent = (it.dur ? fmt(it.dur) + ' · ' : '') + size(it.size);
    b.onclick = () => ambOn && ambSel?.key === it.key ? ambStop() : ambStart(it);
    const x = document.createElement('button');
    x.className = 'del'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + it.name);
    x.onclick = async () => {
      if (!confirm(`Remove “${it.name}” from this device?`)) return;
      if (ambSel?.key === it.key) { if (ambOn) ambStop(); ambSel = null; store.set('amb', null); }
      mine = mine.filter(m => m !== it); buffers.delete(it.key);
      renderSounds(); paintAmb();
      if (it.id > 0) db.del('sounds', [it.id], 's').catch(() => {});
    };
    li.append(b, x);
    ul.appendChild(li);
  }
  paintAmb();
}

$('ambFile').onchange = async e => {
  const files = [...e.target.files].filter(isAudio);
  e.target.value = '';
  let lost = 0;
  for (const f of files) {
    if (!playable(f)) { toast(`${f.name} uses a format this browser can't play.`); continue; }
    toast(`Adding ${clean(f.name)}…`, true);
    const meta = { name: clean(f.name), size: f.size, dur: await duration(f) };
    let id = null;
    if (dbOK) try { id = await db.add('sounds', meta, f, 's'); } catch {}
    if (id == null) { lost++; id = tempId--; }
    mine.push({ ...meta, id, key: 'u:' + id, kind: 'mine', blob: id < 0 ? f : null, icon: ICONS.file });
  }
  renderSounds();
  toast(lost ? "Couldn't save to this device; it will play until you close the app." : files.length ? 'Saved. Tap it to play.' : 'No audio files in that selection.');
  navigator.storage?.persist?.().catch(() => {});
};

const lvl = $('ambLevel');
lvl.value = level;
lvl.oninput = () => {
  level = +lvl.value; store.set('ambLevel', level);
  if (master) master.gain.setTargetAtTime(gainOf(level), ctx.currentTime, 0.05);
};
$('ambTog').onclick = () => ambOn ? ambStop() : ambSel ? ambStart(ambSel) : openSheet('ambSheet');
$('ambOpen').onclick = () => openSheet('ambSheet');

// ---------- sheets, picking, install ----------
function openSheet(id) {
  const s = $(id);
  s.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
}
function closeSheet(s) { s.classList.remove('open'); setTimeout(() => s.hidden = true, 260); }
for (const s of document.querySelectorAll('.sheet'))
  s.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(s); });

let pickTarget = null;
function pickMusic(target) {
  pickTarget = target;
  if (!target && folderOK) openSheet('newSheet'); else $('fFiles').click();
}
$('fFiles').onchange = $('fDir').onchange = e => {
  const files = [...e.target.files]; // copy first: Safari empties the live list when value is reset
  e.target.value = '';
  const s = $('newSheet'); if (!s.hidden) closeSheet(s);
  if (files.length) addFiles(files, pickTarget).catch(() => toast("Couldn't read those files."));
  pickTarget = null;
};
$('newFiles').onclick = () => $('fFiles').click();
$('newDir').onclick = () => $('fDir').click();
$('emptyFiles').onclick = () => { pickTarget = null; $('fFiles').click(); };
$('emptyDir').onclick = () => { pickTarget = null; $('fDir').click(); };
$('emptyDir').hidden = $('newDir').hidden = !folderOK;
$('plAdd').onclick = () => pickMusic(view);
$('plEdit').onclick = () => { editing = !editing; render(); };
$('plRename').onclick = () => renamePl(view);
$('plDelete').onclick = () => deletePl(view);

let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('install').hidden = false; });
$('install').onclick = () => { $('install').hidden = true; installEvt?.prompt(); installEvt = null; };
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone && !store.get('tipDone')) $('tip').hidden = false;
$('tipX').onclick = () => { $('tip').hidden = true; store.set('tipDone', true); };

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const pill = $('offline');
  pill.hidden = false; pill.textContent = 'Saving for offline…';
  navigator.serviceWorker.register('sw.js').catch(() => { pill.hidden = true; });
  navigator.serviceWorker.ready.then(() => { pill.textContent = 'Works offline'; pill.classList.add('ok'); });
}

// ---------- start up ----------
(async () => {
  paintShuffle(); buildEq(); paintEq(); renderSounds();
  await loadLibrary();
  const r = store.get('resume'), pl = r && lists.find(p => p.id === r.pl), t = pl?.tracks.find(x => x.id === r.t);
  view = pl || lists[0] || null;
  if (view) await blobs(view);
  render();
  if (t?.blob) { queue(pl, t); load(t, r.at || 0); }

  const [sounds, shipped] = await Promise.all([
    dbOK ? db.all('sounds').catch(() => []) : [],
    fetch('sounds/sounds.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  mine = sounds.map(s => ({ ...s, key: 'u:' + s.id, kind: 'mine', icon: ICONS.file }));
  bundled = (Array.isArray(shipped) ? shipped : []).filter(s => s && s.file)
    .map(s => ({ key: 'f:' + s.file, kind: 'file', url: 'sounds/' + encodeURIComponent(s.file), name: s.name || clean(s.file), icon: ICONS.file }));
  ambSel = allSounds().find(s => s.key === store.get('amb')) || null;
  renderSounds();
  // Get the last-used sound ready so switching it on is instant.
  if (ambSel?.kind === 'synth') renderPCM(ambSel.id).catch(() => {});
})();
