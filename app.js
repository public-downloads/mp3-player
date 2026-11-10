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
const isLrc = f => /\.lrc$/i.test(f.name);
const stem = p => p.replace(/\.[^./]+$/, '').toLowerCase();  // a path or file name without its extension

// ---------- storage (IndexedDB) ----------
// playlists {id, name, note, tracks: [trackId]} · sounds {id, name, size, dur}
// tracks {id, name, type, size, path, and once sorted: title, artist, genre, mood, dur, f, sorted} (see record())
// files: the audio itself, keyed 't<id>' for tracks and 's<id>' for ambience sounds, 'c<id>' for a
// track's cover, shrunk, and 'l<id>' for its lyrics (text)
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
    del: (s, ids, ...prefixes) => tx([s, 'files'], 'readwrite', t => {
      for (const id of ids) { t.objectStore(s).delete(id); for (const p of prefixes) t.objectStore('files').delete(p + id); }
    }),
    save: (key, blob) => tx('files', 'readwrite', t => t.objectStore('files').put(blob, key)),
    drop: key => tx('files', 'readwrite', t => t.objectStore('files').delete(key)),
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
// Every song on the device, once, in playlist order.
const library = () => [...new Set(lists.flatMap(pl => pl.tracks))];
const dirOf = f => { const p = f.webkitRelativePath || ''; return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; };
// What's stored about a track; f holds what vibe.js measured when it listened, myVibe one picked by hand,
// art whether it has a cover (stored as 'c<id>'; undefined until looked for), lyr where its lyrics
// (stored as 'l<id>') came from: 'file', 'lrc', 'web' or 'mine', false for none, undefined until looked for.
// info is a summary of its song details (format, bitrate, album…), kept once they've been read (see detailsOf()).
const record = ({ name, type, size, path, title, artist, genre, mood, dur, f, sorted, myVibe, art, lyr, info }) =>
  ({ name, type, size, path, title, artist, genre, mood, dur, f, sorted, myVibe, art, lyr, info });
const vibeOf = t => t.myVibe || window.Vibe?.classify(t) || '';

async function loadLibrary() {
  try {
    const [pls, trs] = await Promise.all([db.all('playlists'), db.all('tracks')]);
    const byId = new Map(trs.map(t => [t.id, t]));
    for (const t of trs) t.vibe = vibeOf(t);
    lists = pls.map(p => ({ id: p.id, name: p.name, note: p.note || '', tracks: p.tracks.map(id => byId.get(id)).filter(Boolean) }));
  } catch { dbOK = false; }
}

// Blob handles are cheap (the audio stays on disk), so a playlist's are fetched up
// front. That keeps play() inside the tap, which iOS insists on.
function blobs(pl) {
  return pl.ready ||= Promise.all(pl.tracks.map(async t => { if (!t.blob) t.blob = await db.file('t' + t.id).catch(() => null); }));
}

function savePl(pl) {
  if (pl.id < 0 || !lists.includes(pl)) return Promise.resolve();
  return db.put('playlists', { id: pl.id, name: pl.name, note: pl.note || '', tracks: pl.tracks.filter(t => !t.temp).map(t => t.id) }).catch(() => {});
}

// Files from the picker. Playlist files (.m3u/.m3u8, e.g. from Audio Grabber) become playlists of the
// songs they list, picked along with them or already on the device. Without any, a folder pick with songs
// in several folders asks whether to make one playlist or one per folder, and plain file picks make one
// playlist (or join `target`).
// Picking a folder again only adds what's new: a song already here (same file name and size) is reused,
// and a folder whose playlist already has some of its songs adds the rest to that playlist. Picked as one
// playlist, that's also a playlist with every song from last time, even if it's been renamed or merged.
// Lyrics files (.lrc) go with the song of the same name, in the same folder if there are folders.
async function addFiles(picked, target) {
  picked = [...picked];
  const files = picked.filter(isAudio), listFiles = picked.filter(isPlaylistFile), have = library();
  const lrcs = picked.filter(isLrc), lrcAt = new Map(lrcs.map(f => [stem(f.webkitRelativePath || f.name), f]));
  const lrcNamed = new Map(lrcs.map(f => [stem(f.name), f]));
  if (lrcs.length && !files.length && !listFiles.length) {  // lyrics on their own, for songs already here
    const found = lrcs.map(f => [f, have.find(t => stem(t.name) === stem(f.name))]).filter(([, t]) => t && t.lyr !== 'mine');
    for (const [f, t] of found) setLyrics(t, await f.text(), 'lrc');
    return toast(found.length ? `Added lyrics to ${plural(found.length, 'song')}.`
      : "None of those lyrics files has the same name as a song that's here.");
  }
  if (!files.length && !(listFiles.length && have.length && !target)) return toast('No audio files in that selection.');
  let groups = listFiles.length && !target ? await playlistGroups(listFiles, files, have) : folderGroups(files);
  if (!target && !listFiles.length && groups.length > 1) {
    const how = await askFolders(groups);
    if (!how) return;
    if (how === 'one') groups = [{ name: rootName(groups), songs: groups.flatMap(g => g.songs), whole: true }];
  }
  if (!groups.length) return toast(files.length ? "The playlist files don't list any of the chosen songs."
    : "The playlist file doesn't list any songs that are on this device. Pick it together with the songs.");
  // One item per song, even when it's in several playlists, so it's stored on the device only once.
  const known = new Map(have.map(t => [t.name + '|' + t.size, t]));
  const lyricsFor = new Map();  // track → its .lrc file
  const itemFor = f => {
    if (!(f instanceof Blob)) return f;  // a song already here, listed in a playlist file
    const k = f.name + '|' + f.size;
    let t = known.get(k);
    if (t) t.blob ||= f;
    else t = known.set(k, { id: tempId--, name: f.name, type: f.type, size: f.size, path: dirOf(f), blob: f, temp: true }).get(k);
    const lrc = lrcAt.get(stem(f.webkitRelativePath || f.name)) || lrcNamed.get(stem(f.name));
    if (lrc && t.lyr !== 'mine') lyricsFor.set(t, lrc);  // lyrics you typed in win
    return t;
  };
  const fresh = [];
  for (const { name, songs, whole } of groups) {
    const items = songs.map(itemFor), old = items.filter(t => !t.temp);
    fresh.push(gather(items, name, target || lists.find(p => name && p.name === name && items.some(t => p.tracks.includes(t)))
      || (whole && old.length ? lists.find(p => old.every(t => p.tracks.includes(t))) : undefined)));
  }
  // A new song's lyrics wait in memory until persist() has saved the song.
  for (const [t, f] of lyricsFor) f.text().then(text => setLyrics(t, text, 'lrc'), () => {});
  const first = fresh.find(g => g.items.length);
  showPl((first || fresh[0]).pl);
  if (!first) return toast(lyricsFor.size ? `Added lyrics to ${plural(lyricsFor.size, 'song')}.`
    : fresh.length > 1 ? 'Those songs are already in these playlists.' : `Those songs are already in “${view.name}”.`);
  const bad = files.filter(f => !playable(f)).length, w = $('warn');
  w.hidden = !bad;
  if (bad) w.textContent = bad + ' of ' + files.length + " files use a codec this browser can't decode (usually Ogg or Opus). Convert them to MP3 or M4A, or play those in VLC.";

  if (!target && first.isNew && first.items[0].blob) { queue(first.pl, first.items[0]); load(first.items[0]); start(); }
  if (listFiles.length && !target) toast(`${groups.length} playlists from playlist files.`);
  for (const { pl, items } of fresh) if (items.length) persist(pl, items);
}

// Adds songs to the end of a playlist (`into`, or a new one called `name`), skipping ones it has.
function gather(songs, name, into) {
  const isNew = !into, pl = into || { id: tempId--, name: name || 'Playlist ' + (lists.length + 1), tracks: [], ready: null };
  if (isNew) lists.push(pl);
  const items = [...new Set(songs)].filter(t => !pl.tracks.includes(t));
  pl.tracks.push(...items);
  pl.ready = null;  // fetch the new songs' files too
  return { pl, items, isNew };
}

function showPl(pl) {
  view = pl; editing = false;
  blobs(pl); render();
}

// [{dir, name, songs}], one per folder in folder order, songs sorted by name.
const natural = (x, y) => x.localeCompare(y, undefined, { numeric: true });
function folderGroups(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = dirOf(f);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return [...groups].sort(([x], [y]) => natural(x, y)).map(([dir, songs]) => ({
    dir, name: dir ? dir.split('/').pop() : '',
    songs: songs.sort((x, y) => natural(x.name, y.name)),
  }));
}

// The name of the folder that holds all the groups' folders: the one that was picked.
function rootName(groups) {
  let common = null;
  for (const { dir } of groups) {
    const parts = dir.split('/');
    let i = 0;
    if (common) while (i < common.length && parts[i] === common[i]) i++;
    common = common ? common.slice(0, i) : parts;
  }
  return (common || []).filter(Boolean).pop() || '';
}

// [{name, songs}], one per playlist file, in its order. Its lines (apart from # comments) are song paths,
// relative to the playlist file. A path that doesn't fit (e.g. on iPhone, where picked files have no
// folders) is matched by file name instead, first among the picked files, then among the songs already
// here (`have`). Songs it lists that are in neither are left out.
async function playlistGroups(listFiles, files, have) {
  const key = p => p.replace(/\\/g, '/').toLowerCase();
  const byPath = new Map(files.map(f => [key(f.webkitRelativePath || f.name), f]));
  const byName = new Map(), stored = new Map();
  for (const f of files) byName.set(f.name.toLowerCase(), byName.has(f.name.toLowerCase()) ? null : f);  // null: not unique
  for (const t of have) if (!stored.has(t.name.toLowerCase())) stored.set(t.name.toLowerCase(), t);
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
      const name = key(line).split('/').pop();
      const f = byPath.get(parts.join('/')) || byName.get(name) || stored.get(name);
      if (f && !songs.includes(f)) songs.push(f);
    }
    if (songs.length) groups.push({ name: list.name.replace(/\.m3u8?$/i, ''), songs });
  }
  return groups;
}

// Tracks no playlist uses any more. A song can be in several playlists but is stored only once.
const unused = tracks => tracks.filter(t => !t.temp && !lists.some(pl => pl.tracks.includes(t)));

// Copies new tracks into storage one at a time (in the background, in order), then sorts them.
// `said` replaces the closing message ('' for none).
let saving = Promise.resolve();
function persist(pl, items, said) {
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
      try {
        t.id = await db.add('tracks', record(t), t.blob, 't'); t.temp = false;
        if (t.lyr && lyrText.get(t)) await db.save('l' + t.id, lyrText.get(t)).catch(() => {});
      } catch { full = true; }
    }
    await savePl(pl);
    if (!lists.includes(pl)) db.del('tracks', unused(items).map(t => t.id), 't', 'c', 'l').catch(() => {});
    if (full) toast("Storage is full. Some tracks will only play until you close the app.");
    else if (said !== '') toast(said || `Saved “${pl.name}” on this device.` + (/^Playlist \d+$/.test(pl.name) ? ' Tap its name to rename it.' : ''));
    navigator.storage?.persist?.().catch(() => {});
    renderBar();
    remember(true);
    sortSongs();
  });
}

async function deletePl(pl) {
  const shared = pl.tracks.filter(t => lists.some(other => other !== pl && other.tracks.includes(t))).length;
  if (!confirm(`Delete “${pl.name}” and its ${pl.tracks.length - shared} tracks from this device?`
    + (shared ? ` ${shared} more stay, because other playlists have them too.` : ''))) return;
  if (playing === pl) stopMusic();
  lists.splice(lists.indexOf(pl), 1);
  if (view === pl || !lists.includes(view)) { view = lists[0] || null; editing = false; }
  render();
  if (pl.id > 0) await db.del('playlists', [pl.id]).catch(() => {});
  await db.del('tracks', unused(pl.tracks).map(t => t.id), 't', 'c', 'l').catch(() => {});
  return true;
}

async function removeTrack(pl, t) {
  if (playing === pl) {
    if (current() === t) stopMusic();
    else { const cur = current(); order = order.filter(x => x !== t); pos = order.indexOf(cur); }
  }
  pl.tracks.splice(pl.tracks.indexOf(t), 1);
  render();
  await savePl(pl);
  if (unused([t]).length) db.del('tracks', [t.id], 't', 'c', 'l').catch(() => {});
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
  const nav = $('tabs'), all = $('plAllBtn');
  $('tabrow').hidden = !lists.length; nav.textContent = '';
  // A button left of the tabs opens the playlists sheet.
  all.hidden = lists.length < 2;
  all.textContent = 'All ' + lists.length;
  all.setAttribute('aria-label', `All ${lists.length} playlists`);
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
      $('warn').hidden = true; showPl(pl);
    };
    nav.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'tab add'; add.textContent = '+ New';
  add.onclick = () => pickMusic(null);
  nav.appendChild(add);
  renderSide();  // the second pane shows the playlists too
  nav.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// A mouse wheel scrolls the tabs sideways (touch screens swipe them).
$('tabs').addEventListener('wheel', e => {
  const nav = $('tabs');
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || nav.scrollWidth <= nav.clientWidth) return;
  nav.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  e.preventDefault();
}, { passive: false });

$('plAllBtn').onclick = () => {
  picking = null; renderAll(); openSheet('plSheet');
  $('plAll').querySelector('.on')?.scrollIntoView({ block: 'center' });
};

// The playlists sheet: a card for each, with its covers, length and description. Tapping one opens it,
// its ⋯ opens its About sheet. Merge picks several to put together.
let picking = null;  // the playlists picked to merge, while picking
function renderAll() {
  const ul = $('plAll');
  cardArt.clear();
  ul.textContent = '';
  for (const pl of lists) {
    const li = document.createElement('li');
    li.className = 'plcard' + (pl === view ? ' on' : '') + (pl === playing ? ' playing' : '');
    li.innerHTML = '<button class="open"><div class="art"></div><b></b><small></small><span class="desc"></span></button>'
      + '<button class="more"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>';
    const [open, more] = li.children, [box, name, stats, desc] = open.children;
    name.textContent = pl.name;
    stats.textContent = plStats(pl);
    desc.textContent = pl.note || '';
    desc.hidden = !pl.note;
    box.style.setProperty('--h', hue(pl.name));
    if (plArtSeen.has(pl)) paintArt(box, plArtSeen.get(pl));
    cardArt.add(box, async () => paintArt(box, await plArt(pl)));
    open.onclick = () => {
      if (picking) { picking.has(pl) ? picking.delete(pl) : picking.add(pl); return paintPicking(); }
      closeSheet($('plSheet')); $('warn').hidden = true; showPl(pl);
    };
    more.setAttribute('aria-label', 'About ' + pl.name);
    more.onclick = () => openInfo(pl);
    ul.appendChild(li);
  }
  paintPicking();
}

function paintPicking() {
  const on = !!picking, n = picking ? picking.size : 0;
  $('plSheet').classList.toggle('picking', on);
  $('plHead').textContent = !on ? 'Playlists' : n ? plural(n, 'playlist') + ' picked' : 'Pick playlists';
  $('plNew').hidden = $('plDone').hidden = on;
  $('plPick').hidden = on || lists.length < 2;
  $('plMerge').hidden = $('plCancel').hidden = $('plPickNote').hidden = !on;
  $('plMerge').disabled = n < 2;
  $('plMerge').textContent = n >= 2 ? 'Merge ' + n : 'Merge';
  [...$('plAll').children].forEach((li, i) => {
    li.classList.toggle('sel', !!picking?.has(lists[i]));
    li.firstChild.setAttribute('aria-pressed', on ? !!picking.has(lists[i]) : 'false');
  });
}
$('plPick').onclick = () => { picking = new Set(); paintPicking(); };
$('plCancel').onclick = () => { picking = null; paintPicking(); };
$('plMerge').onclick = () => mergePls(lists.filter(p => picking?.has(p)));

// Puts the songs of several playlists into the first of them (in order, each song once) and removes the
// others. No song is deleted: they're all in the merged playlist.
function mergePls(pls) {
  if (pls.length < 2) return;
  const [into, ...rest] = pls, n = new Set(pls.flatMap(p => p.tracks)).size;
  if (!confirm(`Put ${pls.length} playlists together as “${into.name}”, with ${plural(n, 'song')}? `
    + `The other ${plural(rest.length, 'playlist')} go away; no songs are deleted.`)) return;
  const { items } = gather(rest.flatMap(p => p.tracks), into.name, into);
  for (const p of rest) lists.splice(lists.indexOf(p), 1);
  if (rest.includes(playing)) playing = into;
  picking = null;
  // After any saving under way, so that playlists still being saved have their ids.
  saving.then(() => db.del('playlists', rest.map(p => p.id).filter(id => id > 0))).catch(() => {});
  persist(into, items, `Merged ${pls.length} playlists into “${into.name}”.`);
  closeSheet($('plSheet'));
  $('warn').hidden = true;
  showPl(into);
  remember(true);
  openInfo(into);
}

// "12 songs · 48 min"; the time once every song's length is known.
function plStats(pl) {
  const secs = pl.tracks.reduce((s, t) => s + (t.dur || 0), 0);
  return plural(pl.tracks.length, 'song') + (secs && pl.tracks.every(t => t.dur) ? ' · ' + hours(secs) : '');
}
const hours = s => {
  const m = Math.round(s / 60);
  return m < 60 ? Math.max(1, m) + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + m % 60 + ' min' : '');
};

// ---------- a playlist's About sheet ----------
// Its name and a description you write, with Play, Shuffle, Export and Delete.
let infoPl = null, noteTimer = 0;
function openInfo(pl) {
  infoPl = pl;
  $('infoName').value = pl.name;
  $('infoNote').value = pl.note || '';
  $('infoStats').textContent = plStats(pl) + ' · ' + size(plBytes(pl));
  const box = $('infoArt');
  box.style.setProperty('--h', hue(pl.name));
  paintArt(box, plArtSeen.get(pl) || []);
  plArt(pl).then(urls => { if (infoPl === pl) paintArt(box, urls); });
  openSheet('infoSheet');
}

// Keeps what's typed; the name only if it isn't blank.
function saveInfo() {
  clearTimeout(noteTimer);
  const pl = infoPl;
  if (!pl) return;
  const name = $('infoName').value.trim(), note = $('infoNote').value.trim();
  if ((!name || name === pl.name) && note === (pl.note || '')) return;
  if (name) pl.name = name;
  pl.note = note;
  savePl(pl); renderTabs(); renderBar(); session();
  if (!$('plSheet').hidden) renderAll();
}
$('infoName').onchange = saveInfo;
$('infoName').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
$('infoNote').oninput = () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveInfo, 700); };
$('infoPlay').onclick = () => playPl(infoPl, false);
$('infoShuf').onclick = () => playPl(infoPl, true);
$('infoExport').onclick = () => exportPl(infoPl);
$('infoDelete').onclick = async () => {
  saveInfo();
  if (!await deletePl(infoPl)) return;
  infoPl = null;
  closeSheet($('infoSheet'));
  if (!$('plSheet').hidden) renderAll();
};
$('plinfo').onclick = () => openInfo(view);
$('plnote').onclick = () => openInfo(view);
$('plnote').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInfo(view); } };

// Plays a playlist from the top, or shuffled from a random song.
function playPl(pl, mix) {
  for (const id of ['infoSheet', 'plSheet']) if (!$(id).hidden) closeSheet($(id));
  $('warn').hidden = true;
  if (view !== pl) showPl(pl);
  if (shuffle !== mix) { shuffle = mix; store.set('shuffle', shuffle); paintShuffle(); }
  const go = () => {
    const songs = pl.tracks.filter(t => t.blob);
    if (!songs.length) return toast(pl.tracks.length ? "This playlist's songs are missing from this device." : 'This playlist has no songs yet.');
    tapTrack(pl, mix ? songs[Math.random() * songs.length | 0] : songs[0]);
  };
  pl.tracks.some(t => t.blob) ? go() : blobs(pl).then(go);
}

function renderBar() {
  $('empty').hidden = !!lists.length;
  $('plbar').hidden = !view;
  $('plnote').hidden = !view?.note;
  $('mainTitle').textContent = view?.name || '';  // stands in for the tabs when the playlists pane is open
  if (!view) return;
  $('plnote').textContent = view.note;
  const n = view.tracks.length, unsaved = view.temp || view.tracks.some(t => t.temp);
  $('plinfo').textContent = `${n} track${n === 1 ? '' : 's'} · ${size(plBytes(view))}` + (unsaved ? ' · not saved yet' : '');
  $('viewSeg').hidden = editing;
  $('viewList').setAttribute('aria-pressed', !coverView);
  $('viewCovers').setAttribute('aria-pressed', coverView);
  $('plAdd').hidden = editing;
  $('plRename').hidden = $('plExport').hidden = $('plDelete').hidden = !editing;
  $('plEdit').textContent = editing ? 'Done' : 'Edit';
  $('plEdit').classList.toggle('act', editing);
}
const plBytes = pl => pl.tracks.reduce((s, t) => s + (t.size || 0), 0);

let coverView = store.get('covers', false);  // songs as a grid of covers instead of a list

function renderList() {
  list.textContent = '';
  songArt.clear();
  list.classList.toggle('covers', coverView);
  if (!view) return;
  view.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    if (coverView) {
      li.innerHTML = '<div class="art"></div><span class="t"></span><span class="s"><span class="ar"></span><button class="v"></button></span><small class="i"></small>';
      showArt(li.firstChild, t);
      paintNames(li, t);
      if (showInfo && !infoOK(t)) songArt.add(li, () => detailsOf(t).then(() => paintNames(li, t)));
    } else songRow(li, t, i, songArt);
    const v = li.querySelector('.v');
    paintVibe(v, t);
    v.onclick = e => { e.stopPropagation(); openVibe(t); };
    // Long press on Android, right-click elsewhere.
    li.oncontextmenu = e => { e.preventDefault(); openVibe(t); };
    if (!playable(t)) li.classList.add('bad');
    if (editing) {
      const x = document.createElement('button');
      x.className = 'rm'; x.textContent = coverView ? '×' : 'Remove';
      x.setAttribute('aria-label', 'Remove ' + (t.title || clean(t.name)));
      x.onclick = e => { e.stopPropagation(); removeTrack(view, t); };
      li.appendChild(x);
    } else draggable(li, t, view, 'main');
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
  paintSide();
}

// In the covers view: the title and artist from the song's tags once it's been read, its file name till then.
// With song details on, the album, format and bitrate under them.
function paintNames(li, t) {
  li.querySelector('.t').textContent = t.title || t.info?.title || clean(t.name);
  li.querySelector('.ar').textContent = t.artist || t.info?.artist || '';
  li.querySelector('.i').textContent = showInfo ? [t.info?.album, audioLine(t.info)].filter(Boolean).join(' · ') : '';
}

// A song's row in a list: its number and file name. With song details on, the title from its tags instead,
// and a line under it of artist, album, format and bitrate, read once the row scrolls into view (`jobs`).
function songRow(li, t, i, jobs) {
  li.innerHTML = '<span class="n"></span><span class="tx"><span class="t"></span><small class="i"></small></span><button class="v"></button>';
  li.firstChild.textContent = i + 1;
  paintRow(li, t);
  if (showInfo && !infoOK(t)) jobs.add(li, () => detailsOf(t).then(() => paintRow(li, t)));
}
function paintRow(li, t) {
  li.querySelector('.t').textContent = showInfo ? t.title || t.info?.title || clean(t.name) : clean(t.name);
  li.querySelector('.i').textContent = showInfo ? infoLine(t) : '';
}

function setCoverView(on) {
  if (on === coverView) return;
  // Keep the same songs in view across the switch.
  const top = list.getBoundingClientRect().top;
  const first = [...list.children].findIndex(li => li.getBoundingClientRect().bottom > top + 1);
  coverView = on; store.set('covers', on);
  renderBar(); renderList();
  if (first > 0) list.children[first]?.scrollIntoView({ block: 'start' });
  else list.scrollTop = 0;
}
$('viewList').onclick = () => setCoverView(false);
$('viewCovers').onclick = () => setCoverView(true);

// ---------- covers ----------
// A song's cover is read from its file the first time it's on screen, shrunk to a small JPEG and stored
// ('c<id>'), so a grid of hundreds stays light and opens quickly next time. t.art says whether it has one.
const ART = 384;            // pixels across
const artUrl = new Map();   // track → object URL of its cover, '' for none
const artKey = new Map();   // track → its shrunk cover's size, which tells one album's identical covers apart
const artJob = new Map();   // track → the read in progress

function artFor(t) {
  if (artUrl.has(t)) return Promise.resolve(artUrl.get(t));
  if (!artJob.has(t)) artJob.set(t, readArt(t).catch(() => null).then(img => {
    artJob.delete(t);
    if (img === null) return '';  // couldn't read the song; try again another time
    const url = img ? URL.createObjectURL(img) : '';
    artUrl.set(t, url);
    if (img) artKey.set(t, img.size);
    return url;
  }));
  return artJob.get(t);
}

// The shrunk cover, false if the song has none, or null if the song can't be read right now.
async function readArt(t) {
  if (t.art && !t.temp) { const img = await db.file('c' + t.id).catch(() => null); if (img) return img; }
  if (t.art === false) return false;
  const blob = t.blob || await db.file('t' + t.id).catch(() => null);
  if (!blob || !window.Vibe?.cover) return null;
  const pic = await Vibe.cover(blob);
  const img = pic ? await shrink(pic).catch(() => false) : false;
  if (!t.temp && library().includes(t)) {
    t.art = !!img;
    if (img) await db.save('c' + t.id, img).catch(() => {});
    db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
  }
  return img;
}

// A square JPEG of the middle of the picture, at most ART pixels across.
async function shrink(pic) {
  if (!window.createImageBitmap) return pic;
  const bmp = await createImageBitmap(pic), side = Math.min(bmp.width, bmp.height), n = Math.min(ART, side);
  const c = document.createElement('canvas'), g = c.getContext('2d');
  c.width = c.height = n;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, n, n);
  bmp.close?.();
  return new Promise((ok, bad) => c.toBlob(b => b ? ok(b) : bad(new Error('encode')), 'image/jpeg', 0.82));
}

// Up to four different covers from the start of a playlist (fewer if its songs share one).
const plArtSeen = new Map();  // playlist → the covers it showed last, to draw straight away next time
async function plArt(pl) {
  const urls = [], keys = new Set();
  for (const t of pl.tracks.slice(0, 12)) {
    const url = await artFor(t);
    if (url && !keys.has(artKey.get(t))) { keys.add(artKey.get(t)); urls.push(url); if (urls.length === 4) break; }
  }
  plArtSeen.set(pl, urls);
  return urls;
}

// Fills a cover box: one picture, four in a square, or (with none) a tinted square with a note.
function paintArt(box, urls) {
  const show = urls.length >= 4 ? urls.slice(0, 4) : urls.slice(0, 1).filter(Boolean);
  const imgs = box.querySelectorAll('img');
  box.classList.toggle('none', !show.length);
  box.classList.toggle('four', show.length === 4);
  if (imgs.length === show.length && show.every((u, i) => imgs[i].src === u)) return;
  box.textContent = '';
  for (const url of show) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = url; box.appendChild(img); }
}

// A song's cover box, drawn now if its cover is known, else once it scrolls into view.
function showArt(box, t) {
  box.style.setProperty('--h', hue(t.artist || t.title || t.name));
  if (artUrl.has(t)) paintArt(box, [artUrl.get(t)]);
  else songArt.add(box, async () => paintArt(box, [await artFor(t)]));
}

// The same colour for the same name, for boxes with no cover.
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0; return Math.abs(h) % 360; };

// Runs a job for each element once it scrolls near view in root, one job at a time, so only what's
// looked at gets read. clear() drops the jobs of a list that's been drawn again.
function lazy(root) {
  const jobs = new Map(), want = new Set();
  let busy = false;
  const io = window.IntersectionObserver && new IntersectionObserver(es => {
    for (const e of es) e.isIntersecting ? want.add(e.target) : want.delete(e.target);
    pump();
  }, { root, rootMargin: '300px 0px' });
  async function pump() {
    if (busy) return;
    busy = true;
    for (let el; (el = want.values().next().value);) {
      want.delete(el); if (io) io.unobserve(el);
      const job = jobs.get(el);
      jobs.delete(el);
      if (job && el.isConnected) await job().catch(() => {});
    }
    busy = false;
  }
  return {
    add(el, job) { jobs.set(el, job); if (io) io.observe(el); else { want.add(el); pump(); } },
    clear() { if (io) io.disconnect(); jobs.clear(); want.clear(); },
  };
}
const songArt = lazy(list), cardArt = lazy($('plSheet').querySelector('.panel'));

// ---------- sorting by genre and vibe ----------
// Each song is read once, in the background: its genre from its tags, its vibe from how it sounds (vibe.js).
const SORTED = 1;  // bump when vibe.js measures differently, so every song is read again
let sortRun = null, sortPaint = 0;
function sortSongs() {
  if (!window.Vibe || sortRun) return;
  sortRun = (async () => {
    const tried = new Set();
    for (let t; (t = library().find(x => x.sorted !== SORTED && !tried.has(x)));) {
      tried.add(t);
      const blob = t.blob || await db.file('t' + t.id).catch(() => null);
      if (!blob) continue;
      Object.assign(t, await Vibe.read(blob, { name: t.name, path: t.path, dur: t.dur || await duration(blob) }), { sorted: SORTED });
      t.vibe = vibeOf(t);
      if (!t.temp && library().includes(t)) await db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
      clearTimeout(sortPaint); sortPaint = setTimeout(paintSort, 300);
      await new Promise(r => setTimeout(r, 50));  // room for taps between songs
    }
  })().finally(() => { sortRun = null; paintSort(); });
}

function paintSort() {
  if (view) [...list.children].forEach((li, i) => {
    const v = li.querySelector('.v'), t = view.tracks[i];
    if (v && t) { paintVibe(v, t); coverView ? paintNames(li, t) : paintRow(li, t); }
  });
  if (mode('two') && sidePl) [...$('sideList').children].forEach((li, i) => {
    const v = li.querySelector('.v'), t = sidePl.tracks[i];
    if (v && t) { paintVibe(v, t); paintRow(li, t); }
  });
  if (mode('lists')) [...$('sidePls').children].forEach((li, i) => { if (lists[i]) li.querySelector('small').textContent = plStats(lists[i]); });
  paintNowMeta();
  if (!$('sortSheet').hidden) renderSort();
}

// A track's vibe label, which opens the vibe sheet. Hand-picked vibes show brighter.
function paintVibe(b, t) {
  b.textContent = t.vibe || (t.sorted ? 'Set vibe' : '');
  b.hidden = !b.textContent;
  b.classList.toggle('set', !!t.myVibe);
  b.setAttribute('aria-label', (t.vibe ? 'Vibe: ' + t.vibe : 'Set vibe') + ', change');
}

// The vibe sheet for one song: tap a vibe to set it by hand, tap it again (or tap the guess) to go back
// to the guess.
let vibeSong = null;
function openVibe(t) { vibeSong = t; renderVibe(); openSheet('vibeSheet'); }

function renderVibe() {
  const t = vibeSong, guess = window.Vibe?.classify(t) || '';
  $('vibeTitle').textContent = t.title || clean(t.name);
  $('vibeInfo').textContent = [t.artist, t.genre, t.f && t.f.bpm + ' bpm'].filter(Boolean).join(' · ');
  const host = $('vibeChips');
  host.textContent = '';
  for (const v of window.Vibe?.VIBES || []) {
    const b = document.createElement('button');
    b.className = 'chip' + (t.vibe === v ? ' act' : '');
    b.textContent = v;
    b.setAttribute('aria-pressed', t.vibe === v);
    b.onclick = () => setVibe(t, t.myVibe === v || v === guess ? '' : v);
    host.appendChild(b);
  }
  $('vibeNote').textContent = t.myVibe
    ? `You picked ${t.myVibe}. ` + (guess ? `The guess was ${guess}; tap it to go back.` : 'Tap it again to clear it.')
    : guess ? 'Guessed from how it sounds. Tap another vibe if it’s wrong.'
    : t.sorted ? "Couldn't tell from this song. Pick one." : 'Not listened to yet. You can pick one now.';
  // A playlist named after the vibe (e.g. from "A playlist for each vibe") that doesn't have the song yet.
  const pl = t.vibe && lists.find(p => p.name === t.vibe), add = $('vibeAdd');
  add.hidden = !pl || pl.tracks.includes(t);
  if (!add.hidden) {
    add.textContent = `Add it to “${pl.name}”`;
    add.onclick = () => { const g = gather([t], pl.name, pl); persist(pl, g.items, `Added to “${pl.name}”.`); renderVibe(); };
  }
}

function setVibe(t, v) {
  t.myVibe = v || undefined;
  t.vibe = vibeOf(t);
  if (!t.temp && library().includes(t)) db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
  renderVibe(); paintSort();
}

// The sheet: tap vibes and genres (several in a group means any of them), then make a playlist of the
// songs that fit. Making one again with the same name adds the songs it doesn't have yet.
const pickedVibes = new Set(), pickedGenres = new Set();
const genreOf = t => t.genre || 'No genre';
const sortedSongs = () => library().filter(t => t.sorted || t.myVibe);
const fits = (t, vibes, genres) => (!vibes.size || vibes.has(t.vibe)) && (!genres.size || genres.has(genreOf(t)));
const sortName = () => [[...pickedVibes].join(' & '), [...pickedGenres].join(' & ')].filter(Boolean).join(' · ').slice(0, 40);
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
function tally(songs, key) {
  const m = new Map();
  for (const t of songs) { const k = key(t); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function openSort() { renderSort(); openSheet('sortSheet'); sortSongs(); }

function renderSort() {
  const all = library(), songs = sortedSongs(), left = all.filter(t => t.sorted !== SORTED).length;
  $('sortNote').textContent = left
    ? `Listening to your songs: ${all.length - left} of ${all.length} sorted so far. The rest join in as they're done.`
    : "Genres come from the songs' tags, vibes from how they sound (tap a song's vibe in the list to change it). Tap one or more, then make a playlist.";
  const vibesAll = tally(songs, t => t.vibe), genresAll = tally(songs, genreOf);
  const vibes = (window.Vibe?.VIBES || []).filter(v => vibesAll.has(v));
  const genres = [...genresAll.keys()].sort((a, b) =>
    (a === 'No genre') - (b === 'No genre') || genresAll.get(b) - genresAll.get(a) || a.localeCompare(b));
  for (const v of pickedVibes) if (!vibes.includes(v)) pickedVibes.delete(v);
  for (const g of pickedGenres) if (!genres.includes(g)) pickedGenres.delete(g);
  // Each chip counts the songs it would add, given what's picked in the other group.
  chipRow($('sortVibes'), vibes, tally(songs.filter(t => fits(t, new Set(), pickedGenres)), t => t.vibe), pickedVibes);
  chipRow($('sortGenres'), genres, tally(songs.filter(t => fits(t, pickedVibes, new Set())), genreOf), pickedGenres);
  $('sortNoTags').hidden = !songs.length || genres.some(g => g !== 'No genre');

  const name = sortName(), match = songs.filter(t => fits(t, pickedVibes, pickedGenres));
  const same = lists.find(p => p.name === name), fresh = same ? match.filter(t => !same.tracks.includes(t)) : match;
  const mk = $('sortMake');
  mk.disabled = !name || !fresh.length;
  mk.textContent = !name ? 'Tap a vibe or genre' : !match.length ? 'No songs fit that'
    : !same ? `Make “${name}” · ${plural(match.length, 'song')}`
    : fresh.length ? `Add ${plural(fresh.length, 'song')} to “${name}”` : `“${name}” has them all`;
  $('sortEachV').hidden = !vibes.length;
  $('sortEachG').hidden = !genres.some(g => g !== 'No genre');
}

function chipRow(host, names, counts, picked) {
  host.textContent = '';
  if (!names.length) host.innerHTML = '<span class="note">None yet.</span>';
  for (const name of names) {
    const b = document.createElement('button'), n = counts.get(name) || 0;
    b.className = 'chip' + (picked.has(name) ? ' act' : n ? '' : ' zero');
    b.innerHTML = '<span></span> <small></small>';
    b.firstChild.textContent = name; b.lastChild.textContent = n;
    b.setAttribute('aria-pressed', picked.has(name));
    b.onclick = () => { picked.has(name) ? picked.delete(name) : picked.add(name); renderSort(); };
    host.appendChild(b);
  }
}

$('sortMake').onclick = () => {
  const name = sortName(), songs = sortedSongs().filter(t => fits(t, pickedVibes, pickedGenres));
  const { pl, items, isNew } = gather(songs, name, lists.find(p => p.name === name));
  closeSheet($('sortSheet'));
  showPl(pl);
  if (items.length) persist(pl, items, isNew ? `Made “${pl.name}” with ${plural(items.length, 'song')}.` : `Added ${plural(items.length, 'song')} to “${pl.name}”.`);
};

// A playlist named after each vibe or genre; ones that exist get their new songs.
function sortEach(key, names, what) {
  const songs = sortedSongs(), made = [];
  for (const name of names) {
    const g = gather(songs.filter(t => key(t) === name), name, lists.find(p => p.name === name));
    if (g.items.length) made.push(g);
  }
  closeSheet($('sortSheet'));
  if (!made.length) return toast(`Your playlists by ${what} are up to date.`);
  const n = made.filter(g => g.isNew).length, said = [n && 'made ' + plural(n, 'playlist'), made.length > n && 'updated ' + (made.length - n)];
  showPl(made[0].pl);
  made.forEach((g, i) => persist(g.pl, g.items, i < made.length - 1 ? '' : `By ${what}: ${said.filter(Boolean).join(', ')}.`));
}
$('sortEachV').onclick = () => sortEach(t => t.vibe, Vibe.VIBES.filter(v => sortedSongs().some(t => t.vibe === v)), 'vibe');
$('sortEachG').onclick = () => sortEach(t => t.genre, [...tally(sortedSongs(), t => t.genre).keys()], 'genre');

// ---------- playlist files ----------
// Writes the playlist as .m3u8, listing songs by file name: other players find them when it's saved next
// to the songs, and this app matches them by name when it's opened again.
function exportPl(pl) {
  const lines = ['#EXTM3U', '#PLAYLIST:' + pl.name];
  for (const t of pl.tracks) {
    const title = t.title ? (t.artist ? t.artist + ' - ' : '') + t.title : clean(t.name);
    lines.push(`#EXTINF:${t.dur ? Math.round(t.dur) : -1},${title.replace(/[\r\n]+/g, ' ')}`, t.name);
  }
  saveFile(pl.name.replace(/[\\/:*?"<>|]+/g, '_') + '.m3u8', lines.join('\n') + '\n');
}

// Phones get the share sheet (Save to Files, Drive…) if it takes the file; otherwise it downloads.
async function saveFile(name, text) {
  const file = new File([text], name, { type: 'audio/x-mpegurl' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { return await navigator.share({ files: [file] }); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file); link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  // The Windows app (desktop/folder_player.py) asks where to save it instead.
  if (!window.pywebview) toast(`Saved ${name} to your downloads.`);
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
  paintNowLine();
  curEl.textContent = fmt(at); seek.value = 0;
  $('music').hidden = false; footer.classList.add('has-music');
  paintList(); paintNow();
  if (view === playing) list.children[view.tracks.indexOf(t)]?.scrollIntoView({ block: 'nearest' });
  session(); remember(true);
}

function start() {
  a.play().catch(() => {});
  eqSync();
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
  paintList(); paintNow(); session();
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
a.onplay = () => { playBtn.textContent = 'Pause'; fails = 0; session(); position(); lyrFollow(); };
a.onpause = () => { playBtn.textContent = 'Play'; eqRelease(); session(); position(); remember(true); };
a.onloadedmetadata = a.ondurationchange = () => {
  if (pendingSeek) { a.currentTime = Math.max(0, Math.min(pendingSeek, a.duration - 1)); pendingSeek = 0; }
  durEl.textContent = fmt(a.duration); position();
};
a.onerror = () => {
  const t = current();
  if (!a.getAttribute('src') || !t) return;
  nowEl.innerHTML = '<span class="nl"><b></b> — format not supported</span>';
  nowEl.querySelector('b').textContent = 'Skipped ' + clean(t.name);
  if (++fails < order.length) setTimeout(() => step(1), 900);
};
a.ontimeupdate = () => {
  if (seeking) return;
  curEl.textContent = fmt(a.currentTime); durEl.textContent = fmt(a.duration);
  seek.value = a.duration ? a.currentTime / a.duration * 1000 : 0;
  // The two elements drift apart a little. Pull the muted plain one back to the twin:
  // seeking the twin, the one you hear, makes an audible gap on iOS.
  if (eqLive && Math.abs(eqEl.currentTime - a.currentTime) > 0.25) a.currentTime = eqEl.currentTime;
  remember();
};
// Only a real seek moves the twin, not the small drift fixes above.
a.onseeked = () => {
  if (eqLive && Math.abs(eqEl.currentTime - a.currentTime) > 0.5) eqEl.currentTime = a.currentTime;
  position();
  lyrUserAt = 0; paintLine(true);  // the lyrics jump along, even if they'd been scrolled
};
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
  if (t) {
    // The title, artist and album from the song's tags once they've been read; the file and playlist names till then.
    const title = t.title || t.info?.title, artist = t.artist || t.info?.artist;
    ms.metadata = new MediaMetadata({ title: title || clean(t.name), artist: (artist || playing.name) + (amb ? ' · ' + amb : ''),
                                      album: t.info?.album || playing.name, artwork });
    if (!title && !infoOK(t)) detailsOf(t).then(d => { if (d && current() === t) session(); });
  } else if (amb) ms.metadata = new MediaMetadata({ title: amb, artist: 'Ambience', artwork });
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

// ---------- equalizer ----------
// The music always plays from the plain <audio> element, because that is what an iPhone
// keeps playing with the screen locked. With the EQ on, a twin element plays the same
// track through Web Audio filters while the plain one is muted. iOS stops Web Audio when
// the app goes to the background, so there the plain element takes over (no EQ while
// locked) and the EQ comes back with the first tap after you return.
const BANDS = [[60, 'peaking', '60'], [170, 'peaking', '170'], [450, 'peaking', '450'],
               [1200, 'peaking', '1.2k'], [3500, 'peaking', '3.5k'], [10000, 'highshelf', '10k']];
const PRESETS = { Flat: [0, 0, 0, 0, 0, 0], Bass: [6, 4, 1, 0, 0, 0], Treble: [0, 0, 0, 1, 4, 6],
                  Vocal: [-2, -1, 2, 4, 3, 0], Loudness: [5, 2, 0, -1, 2, 5], Soft: [-1, 0, 0, 0, -2, -4] };
const Q = 0.9;
const saved = store.get('eq', {});
const eq = { on: !!saved.on, gains: Array.isArray(saved.gains) ? saved.gains : [...PRESETS.Flat] };
const saveEq = () => store.set('eq', { on: eq.on, gains: eq.gains });
let eqCtx = null, eqEl = null, eqPre = null, eqNodes = null, eqLive = false, eqStale = false, eqIdle = 0, eqWaiting = false;
const tapping = () => navigator.userActivation ? navigator.userActivation.isActive : true;

// A fresh audio engine and twin element. Needs a tap: iOS only starts audio from one.
function eqBuild() {
  try { eqCtx?.close(); } catch {}
  if (eqEl) { eqEl.pause(); eqEl.removeAttribute('src'); }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  eqCtx = new (window.AudioContext || window.webkitAudioContext)();
  eqEl = new Audio();
  eqPre = eqCtx.createGain();
  eqNodes = BANDS.map(([f, type]) => { const n = eqCtx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = Q; return n; });
  eqNodes.reduce((prev, n) => { prev.connect(n); return n; }, eqPre).connect(eqCtx.destination);
  eqCtx.createMediaElementSource(eqEl).connect(eqPre);
  eqStale = false;
  eqApply();
}

// Lines the twin up with the plain player and switches over to it, or hands back.
// The plain element is only muted once the twin is actually playing, so a failure
// anywhere leaves the music audible, just without EQ.
function eqSync() {
  if (!eq.on || a.paused || !current() || (isIOS && document.hidden)) return eqRelease();
  if (!eqCtx || eqStale) {
    if (!tapping()) return eqRelease();
    try { eqBuild(); } catch { return eqRelease(); }
  }
  clearTimeout(eqIdle);
  if (eqCtx.state !== 'running') eqCtx.resume().catch(() => {});
  if (eqEl.src !== a.src) eqEl.src = a.src;
  eqEl.currentTime = a.currentTime;
  const el = eqEl;
  el.play().then(() => {
    if (el !== eqEl || !eq.on || a.paused || eqCtx.state !== 'running' || (isIOS && document.hidden)) return eqRelease();
    a.muted = true; eqLive = true;
    if (Math.abs(el.currentTime - a.currentTime) > 0.1) a.currentTime = el.currentTime;
  }, () => eqRelease());
}

function eqRelease() {
  a.muted = false; eqLive = false;
  eqEl?.pause();
  clearTimeout(eqIdle);
  eqIdle = setTimeout(() => { if (!eqLive && eqCtx?.state === 'running') eqCtx.suspend().catch(() => {}); }, 2000);
}

document.addEventListener('visibilitychange', () => {
  if (!isIOS || !eq.on) return;
  if (document.hidden) { eqRelease(); eqStale = true; return; }
  if (eqWaiting) return;
  eqWaiting = true;
  document.addEventListener('click', () => { eqWaiting = false; eqSync(); }, { once: true, capture: true });
});

function eqApply() {
  if (!eqNodes) return;
  const g = eq.on ? eq.gains : eq.gains.map(() => 0), t = eqCtx.currentTime;
  eqNodes.forEach((n, i) => n.gain.setTargetAtTime(g[i], t, 0.03));
  // Pull the level down by the biggest boost so boosted bands don't clip; the volume slider sets the rest.
  eqPre.gain.setTargetAtTime(Math.pow(10, -Math.max(0, ...g) / 20) * master(), t, 0.03);
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
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue('--' + n).trim();
  g.lineWidth = 1;
  for (const d of [-12, -6, 0, 6, 12]) {
    g.strokeStyle = col(d ? 'press' : 'line2');
    g.beginPath(); g.moveTo(0, y(d)); g.lineTo(w, y(d)); g.stroke();
  }
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const f = 20 * Math.pow(1000, x / w);
    const db = BANDS.reduce((s, [f0, type], i) => s + biquadDb(type, f0, eq.gains[i], f), 0);
    x ? g.lineTo(x, y(db)) : g.moveTo(x, y(db));
  }
  g.strokeStyle = col(eq.on ? 'live' : 'dim'); g.lineWidth = 2; g.stroke();
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
  if (on) eqSync(); else eqRelease();
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

// Ambience plays from its own looping <audio> element rather than Web Audio, so it keeps
// going with the screen locked. Built-in sounds are rendered to a WAV first. iPhones
// ignore an element's volume, so there the level is built into the WAV itself (short
// uploaded clips are decoded so the same works for them); elsewhere the slider simply
// sets the element's volume.
const SR = 44100;
let ambOn = false, ambSel = null, ambJob = 0, ambBusy = null;
let level = store.get('ambLevel', 50);
const gainOf = v => Math.pow(v / 100, 1.6);
const volumeWorks = !isIOS && (() => { const t = new Audio(); t.volume = 0.5; return t.volume === 0.5; })();
const ambEl = new Audio(); ambEl.loop = true;
let ambKey = null, ambSrc = null, ambUrl = null, ambPrimed = false, ambNoted = false, fadeTimer = 0;

// 16-bit stereo WAV from interleaved samples, scaled by gain (at most 1).
function wav(pcm, gain) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44, n);
  if (gain >= 1) out.set(pcm); else for (let i = 0; i < n; i++) out[i] = pcm[i] * gain;
  return new Blob([buf], { type: 'audio/wav' });
}

function interleave(l, r) {
  const out = new Int16Array(l.length * 2);
  for (let i = 0, j = 0; i < l.length; i++) {
    out[j++] = Math.max(-1, Math.min(1, l[i])) * 32767;
    out[j++] = Math.max(-1, Math.min(1, r[i])) * 32767;
  }
  return out;
}

const SILENCE = URL.createObjectURL(wav(new Int16Array(SR / 5), 1));

// Smooth volume change where the platform allows one; elsewhere it just finishes.
function ramp(to, done) {
  clearInterval(fadeTimer);
  if (!volumeWorks) return done?.();
  const from = ambEl.volume, t0 = performance.now();
  fadeTimer = setInterval(() => {
    const x = Math.min(1, (performance.now() - t0) / 600);
    ambEl.volume = from + (to - from) * x;
    if (x === 1) { clearInterval(fadeTimer); done?.(); }
  }, 30);
}

// Puts a source on the ambience element; keepTime carries on from the same spot.
function ambPlay(src, keepTime) {
  const t = keepTime ? ambEl.currentTime : 0, old = ambUrl;
  ambSrc = src;
  ambUrl = URL.createObjectURL(src.pcm ? wav(src.pcm, volumeWorks ? 1 : gainOf(level)) : src.blob);
  ambEl.src = ambUrl;
  if (t) ambEl.addEventListener('loadedmetadata', () => { ambEl.currentTime = t; }, { once: true });
  if (volumeWorks && !keepTime) ambEl.volume = 0;
  if (old) URL.revokeObjectURL(old);
  return ambEl.play().then(() => { if (!keepTime) ramp(ambGain()); });
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

// {pcm}: full-level samples to build a WAV from, or {blob}: a file to play as it is.
const sources = new Map(); // recent ones, most recent last
async function sourceFor(it) {
  if (sources.has(it.key)) { const s = sources.get(it.key); sources.delete(it.key); sources.set(it.key, s); return s; }
  let src;
  if (it.kind === 'synth') {
    const [l, r] = await renderPCM(it.id);
    pcm.delete(it.id);
    src = { pcm: interleave(l, r) };
  } else {
    const blob = it.blob || (it.kind === 'mine' ? await db.file('s' + it.id) : await fetch(it.url).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); }));
    if (!blob) throw new Error('missing');
    if (volumeWorks) return { blob };
    // iPhone: decode clips up to 3 minutes so the level can be built in; longer ones play as they are.
    const dur = it.dur || await duration(blob);
    if (!dur || dur > 185) return { blob, fixed: true };  // a little slack: some files read as 3:00.04
    const buf = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await blob.arrayBuffer());
    src = { pcm: interleave(buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)) };
  }
  sources.set(it.key, src);
  while (sources.size > 3) sources.delete(sources.keys().next().value);
  return src;
}

async function startVoice() {
  const job = ++ambJob, it = ambSel;
  ambBusy = it.key; paintAmb();
  try {
    const src = await sourceFor(it);
    if (job !== ambJob) return;
    ambKey = it.key;
    await ambPlay(src, false);
    if (src.fixed && !ambNoted) { ambNoted = true; toast('On iPhone, sound files longer than 3 minutes play at their own volume.'); }
  } catch {
    if (job === ambJob) { ambOn = false; ambEl.pause(); toast(`Couldn't play ${it.name}.`); session(); }
  } finally {
    if (ambBusy === it.key) ambBusy = null;
    paintAmb();
  }
}

function ambStart(it) {
  held = null;
  // iOS lets an element start playing only from a tap; once it has, it may start again later.
  if (!ambPrimed) { ambPrimed = true; ambEl.src = SILENCE; ambEl.play().catch(() => {}); }
  ambSel = it; ambOn = true;
  store.set('amb', it.key);
  paintAmb(); session();
  if (ambKey === it.key && ambUrl) {   // same sound as before: just carry on
    if (volumeWorks) ambEl.volume = 0;
    ambEl.play().then(() => ramp(ambGain()), () => startVoice());
    return;
  }
  startVoice();
}

function ambStop() {
  ambOn = false; ambJob++;
  ramp(0, () => { if (!ambOn) ambEl.pause(); });
  paintAmb(); session();
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
      mine = mine.filter(m => m !== it); sources.delete(it.key);
      if (ambKey === it.key) ambKey = null;
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
  if (volumeWorks) { clearInterval(fadeTimer); ambEl.volume = ambGain(); }
};
// iPhone: the level is part of the WAV, so it's rebuilt once the slider is let go.
lvl.onchange = () => { if (!volumeWorks && ambOn && ambSrc?.pcm) ambPlay(ambSrc, true).catch(() => {}); };
$('ambTog').onclick = () => ambOn ? ambStop() : ambSel ? ambStart(ambSel) : openSheet('ambSheet');
$('ambOpen').onclick = () => openSheet('ambSheet');

// ---------- volume ----------
// One level for everything: the music (also through the EQ) and the ambience, on top of its own slider.
// iPhones ignore a page's volume (only their buttons set it), so there the slider stays hidden.
let vol = store.get('volume', 100);
const master = () => volumeWorks ? gainOf(vol) : 1;
function ambGain() { return gainOf(level) * master(); }
function setVol(v) {
  vol = Math.max(0, Math.min(100, Math.round(v)));
  store.set('volume', vol);
  a.volume = master();
  if (volumeWorks && ambOn) { clearInterval(fadeTimer); ambEl.volume = ambGain(); }
  eqApply();
  paintVol();
}
function paintVol() {
  const word = vol ? 'Mute' : 'Unmute';
  $('volume').value = vol;
  $('vol').dataset.l = !vol ? 0 : vol < 50 ? 1 : 2;  // the speaker's waves
  $('volMute').setAttribute('aria-label', word); $('volMute').title = word;
}
$('volume').oninput = () => setVol(+$('volume').value);
// The speaker mutes, and brings back the level from before.
$('volMute').onclick = () => {
  if (vol) { store.set('volBack', vol); setVol(0); } else setVol(store.get('volBack', 70) || 70);
};
$('vol').hidden = !volumeWorks;
a.volume = master();
paintVol();

// ---------- split view ----------
// On a wide screen a second pane can sit beside the songs: the song playing with its lyrics, all the
// playlists (on the left, in place of the tabs), or a second playlist.
const MODES = ['now', 'lists', 'two'];
const wide = matchMedia('(min-width: 720px)');
let split = store.get('split', null);  // what the second pane shows, or null when it's closed
if (!MODES.includes(split)) split = null;
let sidePl = null;                     // the playlist in the second pane, in 'two'
const mode = m => split === m && wide.matches;
const sideArt = lazy($('sidePls')), sideInfo = lazy($('sideList'));

function setSplit(m) {
  split = m; store.set('split', m);
  if (m) store.set('splitMode', m);
  applySplit();
}

function applySplit() {
  const on = !!split && wide.matches, body = document.body;
  body.classList.toggle('split', on);
  for (const m of MODES) body.classList.toggle('split-' + m, on && split === m);
  $('splitBtn').setAttribute('aria-pressed', on);
  for (const b of $('sideSeg').children) b.setAttribute('aria-pressed', b.dataset.mode === split);
  $('sideNow').hidden = split !== 'now';
  $('sideLists').hidden = split !== 'lists';
  $('sideTwo').hidden = split !== 'two';
  render(); paintNow();
}
$('splitBtn').onclick = () => {
  const last = store.get('splitMode', 'now');
  setSplit(split ? null : MODES.includes(last) ? last : 'now');
};
$('sideX').onclick = () => setSplit(null);
for (const b of $('sideSeg').children) b.onclick = () => setSplit(b.dataset.mode);
$('sideNew').onclick = () => pickMusic(null);
wide.addEventListener?.('change', () => applySplit());

function renderSide() {
  if (mode('lists')) renderSideLists();
  else if (mode('two')) renderSideTwo();
}

// The playlists pane: a row for each, with its covers. Tapping one shows its songs on the right; a song
// dropped on one is added to it.
function renderSideLists() {
  const ul = $('sidePls'), top = ul.scrollTop;
  sideArt.clear();
  ul.textContent = '';
  for (const pl of lists) {
    const li = document.createElement('li');
    li.className = 'plrow' + (pl === view ? ' on' : '') + (pl === playing ? ' playing' : '');
    li.innerHTML = '<button class="open"><span class="art"></span><span class="txt"><b></b><small></small></span></button>';
    const open = li.firstChild, [box, txt] = open.children;
    txt.firstChild.textContent = pl.name;
    txt.lastChild.textContent = plStats(pl);
    if (pl === view) open.setAttribute('aria-current', 'true');
    box.style.setProperty('--h', hue(pl.name));
    paintArt(box, plArtSeen.get(pl) || []);
    sideArt.add(box, async () => paintArt(box, await plArt(pl)));
    open.onclick = () => { $('warn').hidden = true; showPl(pl); };
    dropPl.set(li, pl);
    ul.appendChild(li);
  }
  ul.scrollTop = top;
}

// The two-playlists pane: another playlist's songs, picked from a menu, to drag songs to and from.
function renderSideTwo() {
  if (!lists.includes(sidePl)) {
    const id = store.get('sidePl', null);
    sidePl = lists.find(p => p.id === id) || lists.find(p => p !== view) || lists[0] || null;
  }
  const sel = $('sidePick'), ul = $('sideList'), top = ul.scrollTop, pl = sidePl;
  sel.textContent = '';
  lists.forEach((p, i) => sel.add(new Option(p.name, i, false, p === pl)));
  sel.disabled = !lists.length;
  $('sideInfo').textContent = pl ? plStats(pl) : '';
  ul.textContent = '';
  if (pl) blobs(pl);  // so a tap plays straight away, which iOS needs
  sideInfo.clear();
  pl?.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    songRow(li, t, i, sideInfo);
    const v = li.querySelector('.v');
    paintVibe(v, t);
    v.onclick = e => { e.stopPropagation(); openVibe(t); };
    li.oncontextmenu = e => { e.preventDefault(); openVibe(t); };
    if (!playable(t)) li.classList.add('bad');
    li.onclick = () => tapTrack(pl, t);
    draggable(li, t, pl, 'side');
    ul.appendChild(li);
  });
  if (!pl?.tracks.length) {
    const li = document.createElement('li');
    li.className = 'none'; li.textContent = pl ? 'No songs yet. Drag some in from the left.' : 'No playlists yet.';
    ul.appendChild(li);
  }
  ul.scrollTop = top;
  paintSide();
}
$('sidePick').onchange = e => {
  sidePl = lists[+e.target.value] || null;
  store.set('sidePl', sidePl?.id ?? null);
  $('sideList').scrollTop = 0;
  renderSideTwo();
};

function paintSide() {
  if (!mode('two') || !sidePl) return;
  const t = current();
  [...$('sideList').children].forEach((li, i) => li.classList.toggle('on', sidePl === playing && sidePl.tracks[i] === t));
}

// ---------- dragging songs to another playlist ----------
// With two playlists side by side, a song dragged across is added to the other one; with the playlists
// pane open, to the playlist it's dropped on. A mouse drags a whole row. Touch drags the grip at its end,
// so swiping still scrolls; tapping the grip adds the song to the other playlist straight away.
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>'
  + '<circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
const dropPl = new WeakMap();  // a row of the playlists pane → its playlist
let drag = null, dragClick = false;
const otherPl = pane => mode('two') ? (pane === 'main' ? sidePl : view) : null;

function draggable(li, t, from, pane) {
  if (!mode('two') && !mode('lists')) return;
  const g = document.createElement('button'), to = otherPl(pane);
  g.className = 'grip'; g.innerHTML = GRIP;
  g.title = to ? `Drag to “${to.name}”, or click to add it there` : 'Drag onto a playlist to add it there';
  g.setAttribute('aria-label', to ? `Add to “${to.name}”` : 'Drag onto a playlist');
  g.onclick = e => {
    e.stopPropagation();
    const pl = otherPl(pane);
    if (!pl) toast('Drag it onto a playlist on the left.');
    else if (pl === from) toast('Both sides show the same playlist.');
    else addTo(pl, t);
  };
  g.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); };  // a long press is the start of a drag
  g.onpointerdown = e => { if (e.button === 0) dragDown(e, t, from, pane); };
  li.appendChild(g);
  li.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button === 0 && !e.target.closest('.grip')) dragDown(e, t, from, pane);
  });
}

function dragDown(e, t, from, pane) {
  if (drag) return;
  drag = { t, from, pane, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, ghost: null, at: null, raf: 0 };
  addEventListener('pointermove', dragMove);
  addEventListener('pointerup', dragUp);
  addEventListener('pointercancel', dragStop);
}

function dragMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.on) {
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 6) return;  // still a click
    drag.on = true;
    const gh = drag.ghost = document.createElement('div');
    gh.className = 'ghost';
    gh.innerHTML = '<span></span><small></small>';
    gh.firstChild.textContent = drag.t.title || clean(drag.t.name);
    document.body.append(gh);
    document.body.classList.add('dragging');
    addEventListener('keydown', dragKey);
    drag.raf = requestAnimationFrame(dragFrame);
  }
  dragOver();
}

// Each frame: the ghost follows the pointer, and a list scrolls while the pointer is near its top or bottom.
function dragFrame() {
  if (!drag?.on) return;
  drag.ghost.style.transform = `translate(${drag.x + 14}px,${drag.y + 12}px)`;
  const box = document.elementFromPoint(drag.x, drag.y)?.closest('#list, #sideList, #sidePls');
  if (box) {
    const r = box.getBoundingClientRect(), edge = 56;
    const d = drag.y < r.top + edge ? drag.y - r.top - edge : drag.y > r.bottom - edge ? drag.y - r.bottom + edge : 0;
    if (d) { box.scrollTop += d / 4; dragOver(); }
  }
  drag.raf = requestAnimationFrame(dragFrame);
}

// Lights up where the song would go, and says so on the ghost.
function dragOver() {
  const at = dropAt(drag.x, drag.y);
  if (at?.el !== drag.at?.el) { drag.at?.el.classList.remove(drag.at.cls); at?.el.classList.add(at.cls); }
  drag.at = at;
  const has = !!at && at.pl.tracks.includes(drag.t);
  drag.ghost.classList.toggle('ok', !!at && !has);
  drag.ghost.lastChild.textContent = !at ? '' : has ? `Already in “${at.pl.name}”` : `Add to “${at.pl.name}”`;
}

// The playlist under the pointer that the song can go into, and the element to light up.
function dropAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (mode('lists')) {
    const row = el.closest('.plrow'), pl = row && dropPl.get(row);
    return pl && pl !== drag.from ? { el: row, cls: 'drop', pl } : null;
  }
  if (!mode('two')) return null;
  const pane = el.closest('#side') ? 'side' : el.closest('#mainPane') ? 'main' : null;
  const pl = pane === 'side' ? sidePl : view;
  return pane && pane !== drag.pane && pl && pl !== drag.from ? { el: $(pane === 'side' ? 'side' : 'mainPane'), cls: 'dropzone', pl } : null;
}

function dragUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { on, at, t } = drag;
  dragStop();
  if (!on) return;
  dragClick = true;  // the click that ends a drag isn't a tap on the song
  setTimeout(() => { dragClick = false; });
  if (at) addTo(at.pl, t);
}

function dragStop() {
  if (!drag) return;
  removeEventListener('pointermove', dragMove);
  removeEventListener('pointerup', dragUp);
  removeEventListener('pointercancel', dragStop);
  removeEventListener('keydown', dragKey);
  cancelAnimationFrame(drag.raf);
  drag.ghost?.remove();
  drag.at?.el.classList.remove(drag.at.cls);
  document.body.classList.remove('dragging');
  drag = null;
}
const dragKey = e => { if (e.key === 'Escape') dragStop(); };
document.addEventListener('click', e => { if (dragClick) { e.stopPropagation(); e.preventDefault(); } }, true);

// Adds one song to the end of a playlist, unless it has it already.
function addTo(pl, t) {
  const name = t.title || clean(t.name);
  if (pl.tracks.includes(t)) return toast(`“${pl.name}” already has “${name}”.`);
  const { items } = gather([t], pl.name, pl);
  if (pl === playing && !order.includes(t)) order.push(t);
  persist(pl, items, `Added “${name}” to “${pl.name}”.`);
  render();
}

// ---------- now playing and lyrics ----------
// The song playing, big, with its words underneath. Lyrics come from the song's own tags, from an .lrc
// file picked with it, from lrclib.net (only when asked), or are typed in. Timed lyrics (LRC) light up
// line by line and scroll along as the song plays; tap a line to jump there.
const lyrText = new Map();   // track → its lyrics, '' for none
const lyrTried = new Set();  // songs already looked up online
const LYR_FROM = { file: "From the song's file", lrc: 'From its .lrc file', web: 'From lrclib.net', mine: 'Added by you' };
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let npFor, npUrl = '';       // the song the pane shows; its full-size cover
let lyr = { t: null };       // what the lyrics area shows: {t, lines | text, busy, wait, msg}
let lyrLine = -1, lyrUserAt = 0, lyrRaf = 0;

function paintNow() {
  if (!mode('now')) return;
  const t = current();
  paintNowMeta();
  if (t === npFor) return lyrFollow();
  npFor = t;
  paintNowArt(t);
  showLyrics(t);
}

function paintNowMeta() {
  if (!mode('now')) return;
  const t = current();
  $('npTitle').textContent = t ? t.title || t.info?.title || clean(t.name) : 'Nothing playing';
  $('npArtist').textContent = t ? t.artist || t.info?.artist || '' : 'Tap a song to play it.';
  $('npInfo').textContent = t && showInfo ? [albumLine(t.info), audioLine(t.info, true)].filter(Boolean).join(' · ') : '';
  $('npFrom').textContent = t && playing ? `From “${playing.name}”` : '';
  $('npMeta').disabled = !t;
}
$('npMeta').onclick = () => openSong(current());

// The stored small cover straight away, then the full-size picture from the song itself.
async function paintNowArt(t) {
  const box = $('npArt');
  if (npUrl) { URL.revokeObjectURL(npUrl); npUrl = ''; }
  box.style.setProperty('--h', hue(t ? t.artist || t.title || t.name : ''));
  paintArt(box, t && artUrl.get(t) ? [artUrl.get(t)] : []);
  if (!t) return;
  const small = await artFor(t);
  if (npFor !== t) return;
  paintArt(box, [small]);
  if (!small || !window.Vibe?.cover) return;
  const blob = t.blob || await db.file('t' + t.id).catch(() => null);
  const pic = blob && await Vibe.cover(blob).catch(() => null);
  if (npFor !== t || !pic) return;
  npUrl = URL.createObjectURL(pic);
  paintArt(box, [npUrl]);
}

async function showLyrics(t) {
  lyr = { t, wait: true };
  paintLyrics();
  if (!t) return;
  const text = await lyricsOf(t);
  lyrView(t, text);
  if (!text && lyr.t === t && store.get('lyrAuto', false) && !lyrTried.has(t)) findOnline(t);
}

// Shows these lyrics, if t is still the song on show.
function lyrView(t, text, msg) {
  if (lyr.t !== t) return;
  lyr = { t, ...parseLyrics(text), msg };
  paintLyrics();
}

function paintLyrics() {
  const { t, lines, text, busy, wait, msg } = lyr, box = $('lyrics'), has = !!(lines || text);
  $('sideNow').classList.toggle('has-lyr', has);
  $('lyrBar').hidden = !t;
  $('lyrEdit').hidden = !has;
  $('lyrSrc').textContent = has ? (LYR_FROM[t.lyr] || '') + (lines ? '' : ' · not timed') : '';
  $('lyrNone').hidden = !t || has || !!wait || !!busy;
  box.textContent = '';
  box.className = 'lyrics' + (lines ? ' timed' : '');
  box.scrollTop = 0;
  lyrLine = -1;
  if (busy) {
    const p = document.createElement('p');
    p.className = 'msg'; p.textContent = busy;
    box.append(p);
  } else if (lines) {
    for (const l of lines) {
      const p = document.createElement('p');
      p.textContent = l.text || '♪';
      p.onclick = () => { if (lyr.t !== current()) return; a.currentTime = l.t; if (a.paused) start(); };
      box.append(p);
    }
    lyrFollow();
  } else if (text) {
    const d = document.createElement('div');
    d.className = 'plain'; d.textContent = text;
    box.append(d);
  }
  if (!$('lyrNone').hidden) {
    $('lyrMsg').textContent = msg || 'No lyrics for this song yet.';
    $('lyrAuto').setAttribute('aria-checked', store.get('lyrAuto', false));
  }
}

// Lights up the line being sung and keeps it in view, unless the lyrics were just scrolled by hand.
function paintLine(again) {
  const { lines, t } = lyr;
  if (!lines || t !== current() || !mode('now')) return;
  const now = a.currentTime + 0.15;  // a hair early reads better
  let lo = 0, hi = lines.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= now) { at = m; lo = m + 1; } else hi = m - 1; }
  if (at === lyrLine && !again) return;
  const box = $('lyrics'), ps = box.children;
  ps[lyrLine]?.classList.remove('on');
  lyrLine = at;
  ps[at]?.classList.add('on');
  const p = ps[Math.max(0, at)];
  if (p && performance.now() - lyrUserAt > 4000)
    box.scrollTo({ top: p.offsetTop - box.clientHeight * 0.38 + p.offsetHeight / 2, behavior: calm.matches ? 'auto' : 'smooth' });
}

// Keeps paintLine going every frame while the song plays and the pane is open.
function lyrFollow() {
  cancelAnimationFrame(lyrRaf);
  const tick = () => { paintLine(); lyrRaf = !a.paused && lyr.lines && mode('now') ? requestAnimationFrame(tick) : 0; };
  tick();
}
// Scrolling the lyrics by hand stops them following the song for a few seconds.
for (const ev of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
  $('lyrics').addEventListener(ev, () => { lyrUserAt = performance.now(); }, { passive: true });

// {lines: [{t, text}]} for timed lyrics (LRC, also with word times or an [offset:]), else {text}.
function parseLyrics(text) {
  const lines = [], plain = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    let s = raw.trim(), m;
    if ((m = s.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i))) { offset = +m[1] / 1000; continue; }
    if (/^\[[a-z]+:[^\]]*\]$/i.test(s)) continue;  // [ar:…], [ti:…] and other tags
    const times = [];
    while ((m = s.match(/^\[(\d+):(\d+(?:[.:]\d+)?)\]\s*/))) { times.push(+m[1] * 60 + parseFloat(m[2].replace(':', '.'))); s = s.slice(m[0].length); }
    s = s.replace(/<\d+:\d+(?:[.:]\d+)?>\s*/g, '').trim();
    if (times.length) for (const t of times) lines.push({ t: Math.max(0, t - offset), text: s });
    else plain.push(s);
  }
  if (lines.length >= 2) return { lines: lines.sort((x, y) => x.t - y.t) };
  const plainText = plain.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return plainText ? { text: plainText } : {};
}

// A song's lyrics: kept on the device, or read from its tags the first time ('' for none).
async function lyricsOf(t) {
  if (lyrText.has(t)) return lyrText.get(t);
  let text = t.lyr && !t.temp ? await db.file('l' + t.id).catch(() => null) : null;
  if (typeof text !== 'string' && t.lyr !== false) {  // not looked for yet, or the stored copy is gone
    const blob = t.blob || await db.file('t' + t.id).catch(() => null);
    const got = blob && window.Vibe?.lyrics ? await Vibe.lyrics(blob).catch(() => null) : null;
    if (!got) return '';                               // can't tell right now
    text = got.text;
    if (lyrText.has(t)) return lyrText.get(t);         // an .lrc file got there first
    t.lyr = text ? 'file' : false;
    if (!t.temp && library().includes(t)) {
      if (text) await db.save('l' + t.id, text).catch(() => {});
      db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
    }
  }
  if (lyrText.has(t)) return lyrText.get(t);
  text = typeof text === 'string' ? text : '';
  lyrText.set(t, text);
  return text;
}

// Keeps a song's lyrics (from 'file', 'lrc', 'web' or 'mine'). '' removes them, and then the file's own
// aren't read again.
function setLyrics(t, text, from) {
  text = String(text || '').trim();
  lyrText.set(t, text);
  t.lyr = text ? from : false;
  if (!t.temp && library().includes(t)) {
    (text ? db.save('l' + t.id, text) : db.drop('l' + t.id)).catch(() => {});
    db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
  }
  lyrView(t, text);
}

async function findOnline(t) {
  lyrTried.add(t);
  if (lyr.t === t) { lyr = { t, busy: 'Looking on lrclib.net…' }; paintLyrics(); }
  let text = '', msg = 'lrclib.net has no lyrics for this song.';
  try { text = await lrclib(t); }
  catch { msg = navigator.onLine === false ? "You're offline, so lyrics can't be looked up." : "Couldn't reach lrclib.net. Try again later."; }
  if (text) setLyrics(t, text, 'web');
  else lyrView(t, '', msg);
}

// Asks lrclib.net for a song's lyrics by its title and artist: from its tags, or from a file name like
// "Artist - Title.mp3". Prefers timed lyrics of a recording about as long as this one.
async function lrclib(t) {
  let { title, artist } = t;
  if (!title) {
    const blob = t.blob || await db.file('t' + t.id).catch(() => null);
    if (blob && window.Vibe?.lyrics) ({ title, artist } = await Vibe.lyrics(blob));
  }
  if (!title) {
    const m = clean(t.name).match(/^(.+?)\s+[-–—]\s+(.+)$/);
    [artist, title] = m ? [m[1], m[2]] : [artist, clean(t.name)];
  }
  title = tidy(title); artist = tidy(artist || '');
  const dur = t.dur || (t === current() && isFinite(a.duration) ? a.duration : 0);
  const ask = async q => {
    const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(q));
    if (!r.ok) throw new Error('lrclib ' + r.status);
    return r.json();
  };
  let hits = artist ? await ask({ track_name: title, artist_name: artist }) : [];
  if (!hits.length) hits = await ask({ q: [artist, title].filter(Boolean).join(' ') });
  const off = h => dur && h.duration ? Math.abs(h.duration - dur) : 0;
  hits = hits.filter(h => h.syncedLyrics || h.plainLyrics).sort((x, y) => off(x) - off(y));
  const best = hits.find(h => h.syncedLyrics && off(h) <= 3) || hits[0];
  if (!best) return '';
  return best.syncedLyrics && off(best) <= 3 ? best.syncedLyrics : best.plainLyrics || best.syncedLyrics || '';
}
// A title without the "(Official Video)" or "[HD]" that downloaded songs often have.
const tidy = s => s.replace(/\s*[(\[][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|mv)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s+/g, ' ').trim();

// Typing or pasting lyrics in.
let lyrSong = null;
function openLyrEdit(t) {
  if (!t) return;
  lyrSong = t;
  $('lyrTitle').textContent = t.title || clean(t.name);
  $('lyrText').value = lyrText.get(t) || '';
  $('lyrDel').hidden = !lyrText.get(t);
  openSheet('lyrSheet');
}
$('lyrEdit').onclick = $('lyrAdd').onclick = () => openLyrEdit(lyr.t);
$('lyrSave').onclick = () => {
  const t = lyrSong, text = $('lyrText').value.trim();
  if (t && text !== (lyrText.get(t) || '')) setLyrics(t, text, 'mine');
  closeSheet($('lyrSheet'));
};
$('lyrDel').onclick = () => {
  if (!lyrSong || !confirm('Remove the lyrics of this song?')) return;
  setLyrics(lyrSong, '', 'mine');
  closeSheet($('lyrSheet'));
};
$('lyrFind').onclick = () => { if (lyr.t) findOnline(lyr.t); };
// "Look up every song online", here and in Settings.
function setLyrAuto(on) {
  store.set('lyrAuto', on);
  $('lyrAuto').setAttribute('aria-checked', on);
  $('setLyr').setAttribute('aria-checked', on);
  if (on && lyr.t && !lyrText.get(lyr.t) && !lyrTried.has(lyr.t)) findOnline(lyr.t);
}
$('lyrAuto').onclick = $('setLyr').onclick = () => setLyrAuto(!store.get('lyrAuto', false));

// ---------- song details ----------
// What a song's file says about itself, read by vibe.js: every tag (artist, album, year, track…) and the
// audio (format, bitrate, sample rate). With "Show song details" on in Settings, a line of it shows under
// each song and in the player. Tapping the song playing, or Details in a song's vibe sheet, shows all of it.
const INFO = 1;                         // bump when vibe.js reads details differently, so they're read again
let showInfo = store.get('info', false);
const infoJob = new Map();              // track → its details, read (or being read) this session
const infoOK = t => t.info?.v === INFO;

// The song's details, read from its file once a session; a summary is kept with the track (t.info) so the
// lines under songs show straight away next time. null if the file can't be read right now.
function detailsOf(t) {
  if (!infoJob.has(t)) infoJob.set(t, (async () => {
    const blob = t.blob || await db.file('t' + t.id).catch(() => null);
    if (!blob || !window.Vibe?.details) return null;
    const d = await Vibe.details(blob, { dur: t.dur || 0 });
    const was = JSON.stringify(t.info);
    t.info = { v: INFO, fmt: d.fmt, kbps: d.kbps, vbr: d.vbr, hz: d.hz, bits: d.bits, title: d.title, artist: d.artist, album: d.album, year: d.year };
    if (!t.dur && d.dur) t.dur = Math.round(d.dur);
    if (JSON.stringify(t.info) !== was && !t.temp && library().includes(t)) db.put('tracks', { id: t.id, ...record(t) }).catch(() => {});
    return d;
  })().catch(() => null).then(d => { if (!d) infoJob.delete(t); return d; }));
  return infoJob.get(t);
}

const khz = hz => +(hz / 1000).toFixed(1) + ' kHz';
const kb = b => b < 1e6 ? Math.max(1, Math.round(b / 1e3)) + ' KB' : size(b);
// "MP3 · 320 kbps", and with `full` the sample rate and bit depth too.
const audioLine = (i, full) => !i ? '' : [i.fmt, i.kbps && i.kbps + ' kbps' + (i.vbr ? ' VBR' : ''),
  full && i.hz && khz(i.hz), full && i.bits && i.bits + '-bit'].filter(Boolean).join(' · ');
const albumLine = i => i?.album ? i.album + (i.year ? ` (${i.year})` : '') : '';
// The line under a song in a list.
const infoLine = t => [t.artist || t.info?.artist, t.info?.album, audioLine(t.info)].filter(Boolean).join(' · ');

// The song playing, in the bottom bar: its file name, or with song details on its title and artist from the
// tags, with the album, format, bitrate and sample rate under them. Tapping it opens the details sheet.
function paintNowLine() {
  const t = current();
  if (!t) return;
  nowEl.innerHTML = '<span class="nl"><b></b><span></span></span><small></small>';
  const [line, sub] = nowEl.children, i = showInfo ? t.info : null, artist = showInfo && (t.artist || i?.artist);
  line.firstChild.textContent = showInfo ? t.title || i?.title || clean(t.name) : clean(t.name);
  line.lastChild.textContent = artist ? ' — ' + artist : '';
  sub.textContent = showInfo ? [albumLine(i), audioLine(i, true)].filter(Boolean).join(' · ') : '';
  nowEl.setAttribute('aria-label', line.textContent + '. Song details');
  if (showInfo && !infoOK(t)) detailsOf(t).then(d => { if (d && current() === t) { paintNowLine(); paintNowMeta(); } });
}
nowEl.onclick = () => openSong(current());

// The details sheet: the cover, then the tags, the audio, what else is in the file, and where it's kept.
let songFor = null;
async function openSong(t) {
  if (!t) return;
  songFor = t;
  const box = $('songArt');
  box.style.setProperty('--h', hue(t.artist || t.title || t.name));
  paintArt(box, artUrl.get(t) ? [artUrl.get(t)] : []);
  artFor(t).then(url => { if (songFor === t) paintArt(box, [url]); });
  paintSong(t);
  $('songSheet').querySelector('.panel').scrollTop = 0;
  openSheet('songSheet');
  const d = await detailsOf(t);
  if (songFor === t) paintSong(t, d);
}

// d: the details, null if the file couldn't be read, undefined while it's being read.
function paintSong(t, d) {
  $('songTitle').textContent = t.title || d?.title || clean(t.name);
  $('songBy').textContent = [d?.artist || t.artist, albumLine(d)].filter(Boolean).join(' · ');
  $('songAudio').textContent = audioLine(d, true);
  $('songMsg').hidden = d !== undefined && d !== null && !!d.tags.length;
  $('songMsg').textContent = d === undefined ? 'Reading the file…' : d === null ? "Couldn't read this song's file."
    : "This file has no tags, so it goes by its file name.";
  const host = $('songFacts');
  host.textContent = '';
  const section = (title, rows) => {
    rows = rows.filter(([, v]) => v || v === 0);
    if (!rows.length) return;
    const h = document.createElement('h3'), dl = document.createElement('dl');
    h.textContent = title; dl.className = 'facts';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k; dd.textContent = v;
      dl.append(dt, dd);
    }
    host.append(h, dl);
  };
  if (d) {
    section('Tags', d.tags);
    section('Audio', [
      ['Format', (d.codec || d.fmt) + (d.container ? ' in ' + d.container : '')],
      ['Bitrate', d.kbps && d.kbps + ' kbps' + (d.vbr ? ', variable' : '')],
      ['Sample rate', d.hz && khz(d.hz)],
      ['Bit depth', d.bits && d.bits + '-bit'],
      ['Channels', d.mode || (d.ch === 1 ? 'Mono' : d.ch === 2 ? 'Stereo' : d.ch && d.ch + ' channels')],
      ['Length', d.dur && fmt(d.dur)],
      ['Encoder', d.encoder],
    ]);
    const pic = d.pic && [String(d.pic.mime || '').replace(/^image\//i, '').toUpperCase().replace('JPG', 'JPEG'), kb(d.pic.size)];
    section('In the file', [
      ['Tag format', d.tagType.join(', ') || 'None'],
      ['Cover', pic ? pic.filter(Boolean).join(' · ') : 'None'],
      ['Lyrics', d.lyrics === 'timed' ? 'Timed' : d.lyrics === 'plain' ? 'Not timed' : 'None'],
    ]);
    section('More tags', d.more);
  }
  section('On this device', [
    ['File', t.name], ['Folder', t.path], ['Size', size(t.size || 0)],
    ['Playlists', lists.filter(p => p.tracks.includes(t)).map(p => p.name).join(', ')],
  ]);
}
$('vibeMore').onclick = () => { const t = vibeSong; closeSheet($('vibeSheet')); openSong(t); };

function setShowInfo(on) {
  showInfo = on; store.set('info', on);
  $('setInfo').setAttribute('aria-checked', on);
  renderList(); if (mode('two')) renderSideTwo();
  paintNowLine(); paintNowMeta();
}

// ---------- sheets, picking, install ----------
function openSheet(id) {
  const s = $(id);
  s.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
}
const closers = {};  // sheet id → what to do as it closes
function closeSheet(s) { s.classList.remove('open'); setTimeout(() => s.hidden = true, 260); closers[s.id]?.(); }
for (const s of document.querySelectorAll('.sheet'))
  s.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(s); });
closers.infoSheet = () => { saveInfo(); infoPl = null; };
closers.songSheet = () => { songFor = null; };

// ---------- settings ----------
// The theme, song details and online lyrics. The themes slide in inside the settings sheet rather than
// opening a sheet of their own, and the app behind is dimmed less there, so each theme shows on it as it's
// tapped.
function openSettings() { paintSettings(); setPage(false); openSheet('setSheet'); }

function paintSettings() {
  const t = Themes.list.find(x => x.id === Themes.current()), songs = library();
  $('setThemeName').textContent = t.name;
  swatch($('setSw'), t);
  $('setInfo').setAttribute('aria-checked', showInfo);
  $('setLyr').setAttribute('aria-checked', store.get('lyrAuto', false));
  $('setAbout').textContent = songs.length
    ? `${plural(songs.length, 'song')} in ${plural(lists.length, 'playlist')}, ${size(songs.reduce((s, x) => s + (x.size || 0), 0))} on this device.` : '';
}

// The main settings page, or the themes (`themes`), sliding in from the side they're on unless `still`.
function setPage(themes, still) {
  const s = $('setSheet'), show = $(themes ? 'setThemes' : 'setMain');
  $('setMain').hidden = themes; $('setThemes').hidden = !themes;
  s.classList.toggle('peek', themes);
  show.classList.remove('in', 'back');
  if (!still) { void show.offsetWidth; show.classList.add(themes ? 'in' : 'back'); }
  s.querySelector('.panel').scrollTop = 0;
  if (!still) (themes ? $('themes').querySelector('[aria-checked=true]') : $('setTheme'))?.focus({ preventScroll: true });
}
$('setOpen').onclick = openSettings;
$('setTheme').onclick = () => setPage(true);
$('themeBack').onclick = () => setPage(false);
$('setInfo').onclick = () => setShowInfo(!showInfo);

// ---------- theme ----------
// The colours themselves live in themes.js, which puts the saved one on before the page draws.
// A theme's little preview: its background, a line of text, a quieter line, and the accent.
const swatch = (el, t) => { for (const [k, v] of [['bg', t.ink], ['text', t.text], ['dim', t.dim], ['live', t.live]]) el.style.setProperty('--sw-' + k, v); };
function buildThemes() {
  const host = $('themes');
  for (const group of Themes.groups) {
    const col = document.createElement('div');
    col.className = 'tgroup';
    col.innerHTML = `<h3>${group}</h3>`;
    for (const t of Themes.list.filter(x => x.group === group)) {
      const b = document.createElement('button');
      b.className = 'theme'; b.dataset.id = t.id; b.setAttribute('role', 'radio');
      b.innerHTML = '<i class="sw" aria-hidden="true"></i><span></span>';
      b.lastChild.textContent = t.name;
      swatch(b.firstChild, t);
      b.onclick = () => { Themes.set(t.id); paintThemes(); paintSettings(); };
      col.appendChild(b);
    }
    host.appendChild(col);
  }
  paintThemes();
}
function paintThemes() {
  for (const b of $('themes').querySelectorAll('.theme')) b.setAttribute('aria-checked', b.dataset.id === Themes.current());
}

// A folder pick with songs in several folders: one playlist for all of them, or one for each folder.
// Resolves with 'one', 'each', or null if the sheet is closed.
let foldDone = null;
function askFolders(groups) {
  const n = groups.reduce((k, g) => k + g.songs.length, 0), root = rootName(groups);
  $('foldTitle').textContent = `${plural(n, 'song')} in ${plural(groups.length, 'folder')}`;
  $('foldOneInfo').textContent = (root ? `“${root}”, with` : 'With') + ` all ${plural(n, 'song')}`;
  $('foldEachInfo').textContent = groups.slice(0, 3).map(g => g.name || root || 'Songs').join(', ')
    + (groups.length > 3 ? ` and ${groups.length - 3} more` : '');
  openSheet('foldSheet');
  return new Promise(done => { foldDone?.(null); foldDone = done; });
}
function foldPick(how) { const done = foldDone; foldDone = null; closeSheet($('foldSheet')); done?.(how); }
$('foldOne').onclick = () => foldPick('one');
$('foldEach').onclick = () => foldPick('each');
closers.foldSheet = () => { const done = foldDone; foldDone = null; done?.(null); };

let pickTarget = null;
function pickMusic(target) {
  pickTarget = target;
  const have = library().length > 0;
  if (target || !(folderOK || have)) return $('fFiles').click();
  $('newList').hidden = $('newSort').hidden = !have;
  openSheet('newSheet');
}
$('fFiles').onchange = $('fDir').onchange = $('fList').onchange = e => {
  const files = [...e.target.files]; // copy first: Safari empties the live list when value is reset
  e.target.value = '';
  const s = $('newSheet'); if (!s.hidden) closeSheet(s);
  if (files.length) addFiles(files, pickTarget).catch(() => toast("Couldn't read those files."));
  pickTarget = null;
};
$('newFiles').onclick = () => $('fFiles').click();
$('newDir').onclick = () => $('fDir').click();
$('newList').onclick = () => $('fList').click();
$('plNew').onclick = () => { closeSheet($('plSheet')); pickMusic(null); };
$('newSort').onclick = () => { closeSheet($('newSheet')); openSort(); };
$('emptyFiles').onclick = () => { pickTarget = null; $('fFiles').click(); };
$('emptyDir').onclick = () => { pickTarget = null; $('fDir').click(); };
$('emptyDir').hidden = $('newDir').hidden = !folderOK;
$('plAdd').onclick = () => pickMusic(view);
$('plEdit').onclick = () => { editing = !editing; render(); };
$('plRename').onclick = () => mode('lists') ? openInfo(view) : renamePl(view);  // no tabs to type in then
$('mainTitle').onclick = () => openInfo(view);
$('plExport').onclick = () => exportPl(view);
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
  paintShuffle(); buildEq(); paintEq(); renderSounds(); buildThemes(); applySplit();
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
    .map(s => ({ key: 'f:' + s.file, kind: 'file', url: 'sounds/' + encodeURIComponent(s.file), name: s.name || clean(s.file), icon: ICONS[s.icon] || ICONS.file }));
  ambSel = allSounds().find(s => s.key === store.get('amb')) || null;
  renderSounds();
  // Get the last-used sound ready so switching it on is instant.
  if (ambSel?.kind === 'synth') renderPCM(ambSel.id).catch(() => {});
  setTimeout(sortSongs, 2000);
})();
