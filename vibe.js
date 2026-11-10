/* Folder Player — sorts songs by genre and vibe, finds their cover pictures and lyrics, and reads the rest
 * of what a file says about itself (every tag, bitrate, sample rate, codec) for the song details sheet.
 *
 * Genre comes from the file's own tags (ID3 in MP3, the iTunes atoms in M4A, Vorbis
 * comments in FLAC and Ogg), or failing that from a folder named after a genre.
 *
 * Vibe comes from listening to about 45 seconds from the middle of the song: how loud
 * and busy it is, its tempo and how steady the beat is, how bright it sounds, and
 * whether it leans major or minor. A mood tag, or a genre that settles it (ambient,
 * metal, house), wins over the guess. Only those measurements are stored, so the
 * rules in classify() can change without listening to every song again.
 *
 * Runs on the main thread, because decoding needs an audio context, as self.Vibe.
 */
(function (global) {
  'use strict';

  // ---- tags ----------------------------------------------------------------

  // The numbered genres of ID3v1, which ID3v2 and M4A files also refer to.
  const ID3V1 = ('Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|'
    + 'Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|'
    + 'Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|Alternative Rock|Bass|Soul|'
    + 'Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|'
    + 'Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|'
    + 'Cabaret|New Wave|Psychedelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|'
    + 'Rock & Roll|Hard Rock|Folk|Folk-Rock|National Folk|Swing|Fast Fusion|Bebop|Latin|Revival|Celtic|Bluegrass|'
    + 'Avantgarde|Gothic Rock|Progressive Rock|Psychedelic Rock|Symphonic Rock|Slow Rock|Big Band|Chorus|Easy Listening|'
    + 'Acoustic|Humour|Speech|Chanson|Opera|Chamber Music|Sonata|Symphony|Booty Bass|Primus|Porn Groove|Satire|Slow Jam|'
    + 'Club|Tango|Samba|Folklore|Ballad|Power Ballad|Rhythmic Soul|Freestyle|Duet|Punk Rock|Drum Solo|A Cappella|'
    + 'Euro-House|Dancehall|Goa|Drum & Bass|Club-House|Hardcore|Terror|Indie|Britpop|Afro-Punk|Polsk Punk|Beat|'
    + 'Christian Gangsta Rap|Heavy Metal|Black Metal|Crossover|Contemporary Christian|Christian Rock|Merengue|Salsa|'
    + 'Thrash Metal|Anime|J-Pop|Synthpop').split('|');
  const KNOWN = new Set(ID3V1.map(g => g.toLowerCase()));
  // Spellings that mean the same genre, so they end up in one playlist.
  const ALIASES = [
    [/^(hip[\s-]?hop|rap)$/i, 'Hip-Hop'],
    [/^(r\s?(&|n|and)\s?b|rnb|rhythm (&|and) blues)$/i, 'R&B'],
    [/^electr(o|onic|onica)$/i, 'Electronic'],
    [/^(edm|electronic dance music)$/i, 'EDM'],
    [/^(drum\s?(&|n|'n'|and)\s?bass|dnb|d&b)$/i, 'Drum & Bass'],
    [/^lo[\s-]?fi( hip[\s-]?hop)?$/i, 'Lo-Fi'],
    [/^(soundtracks?|score|film score|ost)$/i, 'Soundtrack'],
    [/^(classic|klassik)$/i, 'Classical'],
    [/^(alt|alternative)$/i, 'Alternative'],
    [/^chill[\s-]?out$/i, 'Chillout'],
    [/^synth[\s-]?pop$/i, 'Synthpop'],
    [/^k[\s-]?pop$/i, 'K-Pop'],
    [/^j[\s-]?pop$/i, 'J-Pop'],
  ];
  // Not genres. The YouTube categories come with songs saved by YouTube downloaders.
  const JUNK = new RegExp('^(other|unknown( genre)?|genre|misc|none|default|music|various|entertainment|people & blogs|film & animation|'
    + 'news & politics|gaming|education|howto & style|science & technology|travel & events|autos & vehicles|pets & animals|'
    + 'sports|nonprofits & activism)$', 'i');

  const latin1 = new TextDecoder('latin1'), utf8 = new TextDecoder('utf-8');
  const utf16le = new TextDecoder('utf-16le'), utf16be = new TextDecoder('utf-16be');
  const bytes = async (blob, from, to) => new Uint8Array(await blob.slice(from, to).arrayBuffer());
  const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const syncsafe = (b, o) => (b[o] & 0x7f) << 21 | (b[o + 1] & 0x7f) << 14 | (b[o + 2] & 0x7f) << 7 | (b[o + 3] & 0x7f);
  const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const put = (o, k, v) => { v = String(v || '').trim(); if (v && !o[k]) o[k] = v; };

  // {title, artist, genre, mood, bpm}, each only if the file has it.
  async function tags(blob, head) {
    let t = {};
    try {
      const magic = str4(head, 0);
      if (magic.startsWith('ID3')) t = await id3v2(blob);
      else if (magic === 'fLaC') t = await flac(blob);
      else if (magic === 'OggS') t = await ogg(blob);
      else if (str4(head, 4) === 'ftyp') t = await mp4(blob);
      if (!t.genre || !t.title) { const v1 = await id3v1(blob); if (v1) for (const k in v1) put(t, k, v1[k]); }
    } catch {}
    return t;
  }

  const ID3_FRAMES = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TCON: 'genre', TCO: 'genre',
                       TBPM: 'bpm', TBP: 'bpm', TMOO: 'mood', TXXX: 'user', TXX: 'user',
                       USLT: 'plain', ULT: 'plain', SYLT: 'synced', SLT: 'synced' };
  const TAG_FRAMES = new Set(Object.keys(ID3_FRAMES));
  async function id3v2(blob) {
    const out = {};
    await id3frames(blob, TAG_FRAMES, (id, d) => {
      const key = ID3_FRAMES[id];
      if (key === 'plain') return put(out, key, uslt(d));
      if (key === 'synced') return put(out, key, sylt(d));
      const text = id3text(d);
      if (key !== 'user') put(out, key, text);
      else if (/^mood\0/i.test(text)) put(out, 'mood', text.slice(5));
    });
    return out;
  }

  // Lyrics frames: encoding, language, a description ending in a zero, then the words.
  function uslt(d) {
    const enc = d[0];
    return decodeAs(d.subarray(skipStr(d, 4, enc)), enc);
  }
  // Timed lyrics: ...then each line (or syllable) ending in a zero, followed by its time. Only times in
  // milliseconds are used. Returned as LRC text, one line per time, or per new line for syllables.
  function sylt(d) {
    const enc = d[0];
    if (d[4] !== 2) return '';
    const parts = [];
    for (let p = skipStr(d, 6, enc); p < d.length;) {
      const end = skipStr(d, p, enc);
      if (end + 4 > d.length) break;
      parts.push({ ms: u32(d, end), text: decodeAs(d.subarray(p, end), enc) });
      p = end + 4;
    }
    const breaks = parts.some(x => /^[\r\n]/.test(x.text)), lines = [];
    for (const x of parts) {
      if (!breaks || !lines.length || /^[\r\n]/.test(x.text)) lines.push({ ms: x.ms, text: x.text.trim() });
      else lines[lines.length - 1].text += x.text.replace(/[\r\n]+/g, ' ');
    }
    const stamp = ms => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(2).padStart(5, '0')}]`;
    return lines.map(l => stamp(l.ms) + l.text.trim()).join('\n');
  }
  // The index just past a zero-terminated string at p (two zero bytes in UTF-16).
  function skipStr(d, p, enc) {
    if (enc === 1 || enc === 2) { while (p + 1 < d.length && (d[p] || d[p + 1])) p += 2; return p + 2; }
    const z = d.indexOf(0, p);
    return z < 0 ? d.length : z + 1;
  }

  // Calls fn(id, data, version) for each ID3v2 frame named in `want`, its data ready to read.
  async function id3frames(blob, want, fn) {
    const h = await bytes(blob, 0, 10), ver = h[3], flags = h[5], v2 = ver === 2, hl = v2 ? 6 : 10;
    let b = await bytes(blob, 10, 10 + Math.min(syncsafe(h, 6), 16 << 20));
    if (ver < 4 && flags & 0x80) b = unsync(b);
    let p = flags & 0x40 ? (ver === 4 ? syncsafe(b, 0) : 4 + u32(b, 0)) : 0;  // extended header
    while (p + hl <= b.length) {
      const id = String.fromCharCode(...b.subarray(p, p + (v2 ? 3 : 4)));
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;  // padding
      const len = v2 ? b[p + 3] << 16 | b[p + 4] << 8 | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : u32(b, p + 4);
      const fl = v2 ? 0 : b[p + 9];
      let d = b.subarray(p + hl, p + hl + len);
      p += hl + len;
      if (!want.has(id) || fl & (ver === 4 ? 0x0c : 0xc0)) continue;  // compressed or encrypted
      if (fl & (ver === 4 ? 0x40 : 0x20)) d = d.subarray(1);  // group byte
      if (ver === 4 && fl & 0x01) d = d.subarray(4);            // data length
      if (ver === 4 && (fl & 0x02 || flags & 0x80)) d = unsync(d);
      fn(id, d, ver);
    }
  }

  const id3text = d => decodeAs(d.subarray(1), d[0]);
  // Text in one of ID3's encodings: 0 Latin-1, 1 UTF-16 with a byte order mark, 2 UTF-16BE, 3 UTF-8.
  function decodeAs(b, enc) {
    const dec = enc === 3 ? utf8 : enc === 2 || (enc === 1 && b[0] === 0xfe) ? utf16be : enc === 1 ? utf16le : latin1;
    return dec.decode(b).replace(/[﻿￾]/g, '').replace(/\0+$/, '');
  }

  function unsync(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0) i++; }
    return out.subarray(0, n);
  }

  async function id3v1(blob) {
    if (blob.size < 128) return null;
    const b = await bytes(blob, blob.size - 128, blob.size);
    if (str4(b, 0).slice(0, 3) !== 'TAG') return null;
    const str = (o, n) => latin1.decode(b.subarray(o, o + n)).split('\0')[0];
    return { title: str(3, 30), artist: str(33, 30), genre: ID3V1[b[127]] };
  }

  // M4A: moov > udta > meta > ilst, one box per tag, each holding a 'data' box.
  const MP4_ATOMS = { '©nam': 'title', '©ART': 'artist', '©gen': 'genre', gnre: 'gnre', tmpo: 'bpm', '©lyr': 'plain' };
  // {moov, items}: the moov box's bytes and the tag boxes in its ilst.
  async function mp4items(blob) {
    let moov = null;
    for (let p = 0; p + 8 <= blob.size;) {
      const h = await bytes(blob, p, p + 16);
      let len = u32(h, 0), hl = 8;
      if (len === 1) { len = u32(h, 8) * 4294967296 + u32(h, 12); hl = 16; } else if (len === 0) len = blob.size - p;
      if (len < hl) break;
      if (str4(h, 4) === 'moov') { moov = await bytes(blob, p + hl, p + Math.min(len, 64 << 20)); break; }
      p += len;
    }
    const udta = moov && box(moov, 'udta'), meta = udta && box(moov, 'meta', udta.from, udta.to);
    const ilst = meta && box(moov, 'ilst', meta.from + (str4(moov, meta.from + 4) === 'hdlr' ? 0 : 4), meta.to);
    return { moov, items: ilst ? [...boxes(moov, ilst.from, ilst.to)] : [] };
  }

  async function mp4(blob) {
    const { moov, items } = await mp4items(blob), out = {};
    for (const item of items) {
      let key = MP4_ATOMS[item.type];
      if (item.type === '----') {  // free-form, e.g. com.apple.iTunes:MOOD
        const name = box(moov, 'name', item.from, item.to);
        if (name && /^mood$/i.test(utf8.decode(moov.subarray(name.from + 4, name.to)))) key = 'mood';
      }
      const data = key && box(moov, 'data', item.from, item.to);
      if (!data) continue;
      const v = moov.subarray(data.from + 8, data.to);
      if (key === 'gnre') put(out, 'genre', ID3V1[(v[0] << 8 | v[1]) - 1]);
      else if (key === 'bpm') put(out, 'bpm', v[0] << 8 | v[1]);
      else put(out, key, utf8.decode(v));
    }
    return out;
  }

  function* boxes(b, from, to) {
    for (let p = from; p + 8 <= to;) {
      let len = u32(b, p), hl = 8;
      if (len === 1) { len = u32(b, p + 8) * 4294967296 + u32(b, p + 12); hl = 16; } else if (len === 0) len = to - p;
      if (len < hl || p + len > to) return;
      yield { type: str4(b, p + 4), from: p + hl, to: p + len };
      p += len;
    }
  }
  const box = (b, type, from = 0, to = b.length) => { for (const x of boxes(b, from, to)) if (x.type === type) return x; return null; };

  async function flac(blob) {
    const [c] = await flacBlocks(blob, 4, true);
    return c ? vorbis(c, 0) : {};
  }

  // The FLAC metadata blocks of one type (4 tags, 6 pictures), as bytes; with `one`, only the first.
  async function flacBlocks(blob, type, one) {
    const out = [];
    for (let p = 4, i = 0; i < 64 && p + 4 <= blob.size; i++) {
      const h = await bytes(blob, p, p + 4), len = h[1] << 16 | h[2] << 8 | h[3];
      if ((h[0] & 0x7f) === type) { out.push(await bytes(blob, p + 4, p + 4 + len)); if (one) break; }
      if (h[0] & 0x80) break;  // last block
      p += 4 + len;
    }
    return out;
  }

  async function ogg(blob) {
    const b = await bytes(blob, 0, 1 << 17), s = latin1.decode(b);
    let i = s.indexOf('\x03vorbis'), skip = 7;
    if (i < 0) { i = s.indexOf('OpusTags'); skip = 8; }
    return i < 0 ? {} : vorbis(b, i + skip);
  }

  const VORBIS = { TITLE: 'title', ARTIST: 'artist', GENRE: 'genre', MOOD: 'mood', BPM: 'bpm', TEMPO: 'bpm',
                   LYRICS: 'plain', UNSYNCEDLYRICS: 'plain', 'UNSYNCED LYRICS': 'plain', SYNCEDLYRICS: 'synced' };
  function vorbis(b, p) {
    const le = o => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0, out = {};
    p += 4 + le(p);  // vendor string
    for (let n = le(p), i = 0, q = p + 4; i < n && q + 4 <= b.length; i++) {
      const len = le(q), s = utf8.decode(b.subarray(q + 4, q + 4 + len)), eq = s.indexOf('=');
      q += 4 + len;
      const key = VORBIS[s.slice(0, eq).toUpperCase()];
      if (key) put(out, key, s.slice(eq + 1));
    }
    return out;
  }

  // One tidy genre from a tag: the first of several, numbered ones looked up, spellings merged.
  function genreName(raw) {
    let g = String(raw || '').split(/[\0;,|/]/).map(s => s.trim()).find(Boolean) || '';
    const n = g.match(/^\((\d+)\)\s*(.*)$/);
    if (n) g = n[2] || ID3V1[n[1]] || '';
    else if (/^\d+$/.test(g)) g = ID3V1[g] || '';
    if (/^\((rx|cr)\)/i.test(g) || JUNK.test(g)) return '';
    for (const [re, name] of ALIASES) if (re.test(g)) return name;
    if (g === g.toLowerCase() || g === g.toUpperCase()) g = g.toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase());
    return g.slice(0, 30);
  }

  // A genre from the nearest folder named after one, e.g. Music/Jazz/Album.
  function fromFolder(path) {
    for (const part of String(path || '').split('/').reverse()) {
      const g = part.trim();
      if (!JUNK.test(g) && (KNOWN.has(g.toLowerCase()) || ALIASES.some(([re]) => re.test(g)))) return genreName(g);
    }
    return '';
  }

  // ---- cover art -----------------------------------------------------------

  // The picture embedded in a song (the front cover if it has several) as an image Blob, or null.
  // Reads ID3 (MP3), the iTunes covr atom (M4A) and FLAC picture blocks.
  async function cover(blob) {
    try {
      const head = await bytes(blob, 0, 12), magic = str4(head, 0);
      const pics = magic.startsWith('ID3') ? await id3pics(blob)
        : magic === 'fLaC' ? (await flacBlocks(blob, 6)).map(flacPicture)
        : str4(head, 4) === 'ftyp' ? await mp4pics(blob) : [];
      for (const p of pics.sort((a, b) => (b.type === 3) - (a.type === 3))) {  // 3: front cover
        const img = image(p.data);
        if (img) return img;
      }
    } catch {}
    return null;
  }

  const PIC_FRAMES = new Set(['APIC', 'PIC']);
  async function id3pics(blob) {
    const pics = [];
    await id3frames(blob, PIC_FRAMES, (id, d, ver) => {
      // encoding, MIME type ending in a zero byte (ID3v2.2: a 3-letter format), picture type, description
      const enc = d[0];
      let p = ver === 2 ? 4 : d.indexOf(0, 1) + 1;
      if (!p) return;
      const type = d[p++];
      if (enc === 1 || enc === 2) { while (p + 1 < d.length && (d[p] || d[p + 1])) p += 2; p += 2; }  // UTF-16
      else { const z = d.indexOf(0, p); p = z < 0 ? d.length : z + 1; }
      pics.push({ type, data: d.subarray(p) });
    });
    return pics;
  }

  async function mp4pics(blob) {
    const { moov, items } = await mp4items(blob), pics = [];
    for (const item of items) {
      if (item.type !== 'covr') continue;
      for (const d of boxes(moov, item.from, item.to)) if (d.type === 'data') pics.push({ type: 3, data: moov.subarray(d.from + 8, d.to) });
    }
    return pics;
  }

  // Picture type, MIME type, description, size and colours, then the image.
  function flacPicture(b) {
    let p = 4;
    p += 4 + u32(b, p);  // MIME type
    p += 4 + u32(b, p);  // description
    p += 16;             // width, height, depth, colours
    return { type: u32(b, 0), data: b.subarray(p + 4, p + 4 + u32(b, p)) };
  }

  // The image in b as a Blob, or null if it isn't one a browser shows. Looks a few bytes in too,
  // for files whose picture header is slightly off.
  function image(b) {
    for (let i = 0; i < Math.min(b.length - 12, 64); i++) {
      const type = b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff ? 'image/jpeg'
        : b[i] === 0x89 && str4(b, i + 1).startsWith('PNG') ? 'image/png'
        : str4(b, i) === 'GIF8' ? 'image/gif'
        : str4(b, i) === 'RIFF' && str4(b, i + 8) === 'WEBP' ? 'image/webp' : '';
      if (type) return new Blob([b.subarray(i)], { type });
    }
    return null;
  }

  // ---- listening -----------------------------------------------------------

  const RATE = 11025, SPAN = 45, WHOLE = 30e6;
  let ctx = null;
  function decoder() {
    const C = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    for (const sr of [RATE, 22050, 44100]) { if (ctx) break; try { ctx = new C(1, 1, sr); } catch {} }
    return ctx;
  }
  const decode = buf => new Promise((ok, bad) => decoder().decodeAudioData(buf, ok, bad)?.catch?.(() => {}));

  // {x, sr, dur}: mono samples at RATE from the middle SPAN seconds of the song, or null.
  // MP3 and FLAC are cut to just that stretch before decoding, so a long song costs no
  // more than a short one; a FLAC piece gets the file's header so it still decodes.
  async function excerpt(blob, kind, dur) {
    const tries = [];
    if (kind === 'mp3' || kind === 'flac') {
      const rate = dur > 0 ? blob.size / dur : kind === 'mp3' ? 24e3 : 11e4;  // bytes per second
      const len = Math.min(Math.max(rate * SPAN, 3e5), 8e6) | 0, at = (blob.size - len) / 2 | 0;
      if (blob.size > len * 1.5) {
        const part = blob.slice(at, at + len);
        if (kind === 'mp3') tries.push(part);
        else {
          const head = await bytes(blob, 0, 42);
          if (str4(head, 0) === 'fLaC' && (head[4] & 0x7f) === 0) { head[4] |= 0x80; tries.push(new Blob([head, part])); }
        }
      }
    }
    if (blob.size <= WHOLE) tries.push(blob);
    for (const b of tries) {
      try {
        const buf = await decode(await b.arrayBuffer());
        if (buf.length) return mono(buf, b === blob ? buf.duration : 0);
      } catch {}
    }
    return null;
  }

  function mono(buf, dur) {
    const k = Math.max(1, Math.round(buf.sampleRate / RATE)), n = Math.min(buf.length, SPAN * buf.sampleRate | 0);
    const from = (buf.length - n) >> 1, x = new Float32Array(n / k | 0), w = 1 / (k * buf.numberOfChannels);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0, j = from; i < x.length; i++) { let s = 0; for (let m = 0; m < k; m++) s += d[j++]; x[i] += s * w; }
    }
    return { x, sr: buf.sampleRate / k, dur };
  }

  // In-place radix-2 FFT.
  const tables = new Map();
  function fft(re, im) {
    const n = re.length;
    if (!tables.has(n)) {
      const bits = Math.log2(n), rev = new Uint32Array(n), cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= (i >> b & 1) << (bits - 1 - b); rev[i] = r; }
      for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
      tables.set(n, { rev, cos, sin });
    }
    const { rev, cos, sin } = tables.get(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, xr = re[b] * cos[k] - im[b] * sin[k], xi = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // Calls fn(mag, frame) with the magnitude spectrum of each Hann-windowed frame.
  function spectra(x, n, hop, fn) {
    const win = new Float32Array(n), re = new Float32Array(n), im = new Float32Array(n), mag = new Float32Array(n / 2);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    for (let o = 0, f = 0; o + n <= x.length; o += hop, f++) {
      for (let i = 0; i < n; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      fn(mag, f);
    }
  }

  // Key profiles (Krumhansl–Kessler), from the tonic up.
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(c, p, key) {
    let mc = 0, mp = 0, sc = 0, sp = 0, cp = 0;
    for (let i = 0; i < 12; i++) { mc += c[i] / 12; mp += p[i] / 12; }
    for (let i = 0; i < 12; i++) {
      const a = c[i] - mc, b = p[(i - key + 12) % 12] - mp;
      sc += a * a; sp += b * b; cp += a * b;
    }
    return sc && sp ? cp / Math.sqrt(sc * sp) : 0;
  }

  // The measurements a vibe is guessed from:
  //   loud: average level in dBFS · act: spectral change per second (how much is going on)
  //   noise: spectral flatness, high with drums, distortion and synth noise
  //   bpm: tempo · beat: how steady the beat is (0 none, 1 metronome)
  //   bright: spectral centroid in Hz · minor: leans minor above 0, major below
  function listen(x, sr) {
    const hop = 128, dt = hop / sr, frames = Math.floor((x.length - 512) / hop) + 1;
    if (frames * dt < 4) return null;
    let ss = 0;
    for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
    const loud = 10 * Math.log10(ss / x.length + 1e-12);

    // Spectral flux (how much louder each frequency got since the last frame) shows onsets.
    const flux = new Float32Array(frames);
    let prev = new Float32Array(256), cur = new Float32Array(256), num = 0, den = 0, flat = 0, heard = 0;
    spectra(x, 512, hop, (mag, f) => {
      let d = 0, p = 0, lg = 0;
      for (let k = 1; k < 256; k++) {
        const m = mag[k], l = Math.log1p(m * 10);
        cur[k] = l; if (f && l > prev[k]) d += l - prev[k];
        num += k * m; den += m; p += m * m; lg += Math.log(m * m + 1e-12);
      }
      if (p > 1e-6) { flat += Math.exp(lg / 255) / (p / 255); heard++; }
      flux[f] = d;
      [prev, cur] = [cur, prev];
    });
    const bright = den ? num / den * sr / 512 : 0;

    // Novelty: flux above its average over the surrounding half second.
    const w = Math.round(0.25 / dt), sum = new Float64Array(frames + 1), nov = new Float32Array(frames);
    for (let i = 0; i < frames; i++) sum[i + 1] = sum[i] + flux[i];
    let mean = 0;
    for (let i = 0; i < frames; i++) {
      const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1);
      nov[i] = Math.max(0, flux[i] - (sum[b] - sum[a]) / (b - a));
      mean += nov[i] / frames;
    }
    const act = sum[frames] / (frames * dt), noise = heard ? flat / heard : 0;

    // Tempo: the lag (50–200 bpm) where the novelty best lines up with itself, nudged toward 120.
    const lo = Math.floor(60 / (200 * dt)), hi = Math.ceil(60 / (50 * dt)), acf = new Float32Array(hi + 2);
    let v0 = 0;
    for (let i = 0; i < frames; i++) { nov[i] -= mean; v0 += nov[i] * nov[i]; }
    v0 /= frames;
    for (let L = lo - 1; L <= hi + 1; L++) {
      let s = 0;
      for (let i = 0; i + L < frames; i++) s += nov[i] * nov[i + L];
      acf[L] = v0 ? s / (frames - L) / v0 : 0;
    }
    let best = lo, top = -Infinity;
    for (let L = lo; L <= hi; L++) {
      const s = acf[L] * Math.exp(-0.5 * (Math.log2(60 / (L * dt) / 120) / 0.9) ** 2);
      if (s > top) { top = s; best = L; }
    }
    const a = acf[best - 1], b = acf[best], c = acf[best + 1], shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
    const bpm = 60 / ((best + Math.max(-0.5, Math.min(0.5, shift))) * dt);

    // Key: how strongly each pitch class sounds, matched against major and minor profiles.
    const N = 4096, pc = new Int8Array(N / 2).fill(-1), chroma = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      if (f > 80 && f < 2000) pc[k] = ((Math.round(12 * Math.log2(f / 261.63)) % 12) + 12) % 12;
    }
    spectra(x, N, N / 2, mag => { for (let k = 1; k < N / 2; k++) if (pc[k] >= 0) chroma[pc[k]] += mag[k]; });
    let maj = -1, min = -1;
    for (let key = 0; key < 12; key++) { maj = Math.max(maj, corr(chroma, MAJOR, key)); min = Math.max(min, corr(chroma, MINOR, key)); }

    const r = (v, d) => Math.round(v * d) / d;
    return { loud: r(loud, 10), act: Math.round(act), noise: r(noise, 1000), bpm: Math.round(bpm), beat: r(Math.max(0, b), 100),
             bright: Math.round(bright), minor: r(min - maj, 1000) };
  }

  // ---- vibe ----------------------------------------------------------------

  const VIBES = ['Calm', 'Chill', 'Moody', 'Upbeat', 'Dance', 'Intense'];
  // Words in a mood tag, and genres that settle the vibe when the song's energy fits.
  const MOODS = [
    [/calm|peace|relax|sooth|dream|medit|sleep|serene|tranquil/i, 'Calm'],
    [/chill|mellow|laid|easy|smooth|cozy|warm|romantic/i, 'Chill'],
    [/sad|melanch|dark|moody|somb(er|re)|gloom|lonely|brood|emotional|bitter/i, 'Moody'],
    [/party|danc|groov|club/i, 'Dance'],
    [/energ|aggress|angry|intense|powerful|epic|hype|heavy|fierce/i, 'Intense'],
    [/happy|upbeat|cheer|joy|uplift|fun|bright|positive|feel.?good|sunny/i, 'Upbeat'],
  ];
  const LEANS = [
    [/ambient|new age|meditat|classical|sonata|symphon|chamber|opera|sleep|drone|piano/i, 'Calm'],
    [/lo-fi|chill|downtempo|trip-hop|easy listening|lounge|bossa|acoustic|slow jam/i, 'Chill'],
    [/metal|hardcore|punk|thrash|grind|industrial|hardstyle|terror|drill/i, 'Intense'],
    [/house|techno|trance|edm|dance|disco|club|drum & bass|rave|garage|dubstep|reggaeton|electro\b|goa/i, 'Dance'],
  ];
  const clamp = v => Math.max(0, Math.min(1, v));
  // 0 (quiet, still, clean) to 1 (loud, lots going on, drums and distortion). Scaled so a library of
  // commercial pop and rock spreads over the middle (median about 0.55).
  const energy = f => 0.35 * clamp((f.loud + 24) / 14) + 0.45 * clamp((f.act - 1500) / 4000) + 0.2 * clamp((f.noise - 0.005) / 0.1);

  // The vibe for a song's stored {f, genre, mood}, or '' if there's nothing to go on.
  function classify({ f, genre = '', mood = '' }) {
    for (const [re, vibe] of MOODS) if (re.test(mood)) return vibe;
    const lean = (LEANS.find(([re]) => re.test(genre)) || [])[1];
    if (!f) return lean || '';
    const e = energy(f), dark = f.minor > 0.08, steady = f.beat > 0.3;
    if (lean === 'Calm' && e < 0.5 || lean === 'Chill' && e < 0.55 || lean === 'Intense' && e > 0.3 || lean === 'Dance' && e > 0.3) return lean;
    if (e < 0.25 && !steady || f.noise > 0.15 && f.beat < 0.15) return 'Calm';  // the second: rain, waves, white noise
    if (e < 0.45) return dark ? 'Moody' : 'Chill';
    if (e >= 0.75 && f.noise > 0.09) return 'Intense';  // loud and distorted
    if (f.beat > 0.55 && f.bpm >= 110 && f.bpm <= 140 && f.noise > 0.04) return 'Dance';  // a machine-steady beat
    if (dark) return e >= 0.7 ? 'Intense' : 'Moody';
    return 'Upbeat';
  }

  // Everything known about one song: {title, artist, genre, mood, dur, f}.
  // `dur` (seconds, if known) helps cut an MP3 to the right length.
  async function read(blob, { name = '', path = '', dur = 0 } = {}) {
    const head = await bytes(blob, 0, 12), ext = (name.split('.').pop() || '').toLowerCase();
    const kind = ext === 'mp3' || (head[0] === 0xff && (head[1] & 0xe6) > 0xe0) ? 'mp3' : str4(head, 0) === 'fLaC' ? 'flac' : '';
    const t = await tags(blob, head);
    let f = null;
    try {
      const ex = await excerpt(blob, kind, dur);
      if (ex) { f = listen(ex.x, ex.sr); dur ||= ex.dur; }
    } catch {}
    if (f && t.bpm >= 40 && t.bpm <= 250) f.bpm = Math.round(t.bpm);  // a tagged tempo beats our guess
    let genre = genreName(t.genre);
    if (t.artist && genre.toLowerCase() === t.artist.toLowerCase()) genre = '';  // the artist, put there by mistake
    return { title: t.title || '', artist: t.artist || '', genre: genre || fromFolder(path),
             mood: t.mood || '', dur: Math.round(dur || 0), f };
  }

  // The words in a song's tags, timed (as LRC text) if the file has them that way, with its title and
  // artist: {text, title, artist}. Reads ID3 USLT/SYLT (MP3), ©lyr (M4A) and LYRICS comments (FLAC, Ogg).
  async function lyrics(blob) {
    const t = await tags(blob, await bytes(blob, 0, 12));
    return { text: t.synced || t.plain || '', title: t.title || '', artist: t.artist || '' };
  }

  // ---- everything else a file says about itself ----------------------------

  // The tags the song details sheet names, in its order. Any others follow under their own names.
  const FIELDS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumartist', 'Album artist'], ['year', 'Year'],
    ['track', 'Track'], ['disc', 'Disc'], ['genre', 'Genre'], ['composer', 'Composer'], ['lyricist', 'Lyricist'],
    ['conductor', 'Conductor'], ['remixer', 'Remixed by'], ['grouping', 'Grouping'], ['subtitle', 'Subtitle'], ['bpm', 'BPM'],
    ['key', 'Key'], ['mood', 'Mood'], ['rating', 'Rating'], ['compilation', 'Compilation'], ['label', 'Label'],
    ['copyright', 'Copyright'], ['isrc', 'ISRC'], ['language', 'Language'], ['comment', 'Comment'], ['url', 'Website'],
    ['encodedby', 'Encoded by']];
  const FIELD = new Map(FIELDS);
  // ID3v2 text frames (v2.3/2.4 and the three-letter v2.2 ones). Lower case: one of FIELDS; else a name.
  const ID3_NAMES = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TPE2: 'albumartist', TP2: 'albumartist',
    TYER: 'year', TYE: 'year', TDRC: 'year', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc', TCON: 'genre', TCO: 'genre',
    TCOM: 'composer', TCM: 'composer', TEXT: 'lyricist', TXT: 'lyricist', TPE3: 'conductor', TP3: 'conductor', TPE4: 'remixer',
    TP4: 'remixer', TIT1: 'grouping', TT1: 'grouping', GRP1: 'grouping', TIT3: 'subtitle', TT3: 'subtitle', TBPM: 'bpm', TBP: 'bpm',
    TKEY: 'key', TKE: 'key', TMOO: 'mood', TCMP: 'compilation', TCP: 'compilation', TPUB: 'label', TPB: 'label',
    TCOP: 'copyright', TCR: 'copyright', TSRC: 'isrc', TRC: 'isrc', TLAN: 'language', TLA: 'language', TENC: 'encodedby',
    TEN: 'encodedby', TSSE: 'encoder', TSS: 'encoder', TDOR: 'Original release', TORY: 'Original release', TOR: 'Original release',
    TOPE: 'Original artist', TOA: 'Original artist', TOAL: 'Original album', TOT: 'Original album', TMED: 'Media', TMT: 'Media',
    TDRL: 'Release date', TDAT: 'Date', TDA: 'Date', TOWN: 'Owner', TRSN: 'Radio station', TDEN: 'Encoded on',
    TDTG: 'Tagged on', TSST: 'Set subtitle', MVNM: 'Movement', MVIN: 'Movement number', TSOT: 'Sort title', TSOP: 'Sort artist',
    TSOA: 'Sort album', TSO2: 'Sort album artist', TSOC: 'Sort composer', TFLT: 'File type', TPRO: 'Produced',
  };
  // Vorbis comment names (FLAC, Ogg), also used by ID3 TXXX frames and M4A free-form tags. '@' names are
  // counted separately: the lyrics, the picture, and how many tracks and discs there are.
  const NAMED = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist',
    DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track', DISCNUMBER: 'disc', GENRE: 'genre', COMPOSER: 'composer',
    LYRICIST: 'lyricist', CONDUCTOR: 'conductor', REMIXER: 'remixer', GROUPING: 'grouping', SUBTITLE: 'subtitle', BPM: 'bpm',
    TEMPO: 'bpm', KEY: 'key', INITIALKEY: 'key', MOOD: 'mood', COMPILATION: 'compilation', LABEL: 'label', ORGANIZATION: 'label',
    PUBLISHER: 'label', COPYRIGHT: 'copyright', ISRC: 'isrc', LANGUAGE: 'language', COMMENT: 'comment', DESCRIPTION: 'comment',
    WEBSITE: 'url', 'ENCODED-BY': 'encodedby', ENCODEDBY: 'encodedby', ENCODER: 'encoder', LYRICS: '@lyrics',
    UNSYNCEDLYRICS: '@lyrics', 'UNSYNCED LYRICS': '@lyrics', SYNCEDLYRICS: '@lyrics', METADATA_BLOCK_PICTURE: '@pic',
    TRACKTOTAL: '@tracks', TOTALTRACKS: '@tracks', DISCTOTAL: '@discs', TOTALDISCS: '@discs' };
  const named = k => NAMED[k.toUpperCase()] || (k === k.toUpperCase() ? k[0] + k.slice(1).toLowerCase().replace(/_/g, ' ') : k);
  const MP4_NAMES = { '©nam': 'title', '©ART': 'artist', aART: 'albumartist', '©alb': 'album', '©day': 'year', trkn: 'track',
    disk: 'disc', '©gen': 'genre', gnre: 'genre', '©wrt': 'composer', '©cmt': 'comment', '©grp': 'grouping', '©too': 'encoder',
    '©enc': 'encodedby', cprt: 'copyright', tmpo: 'bpm', cpil: 'compilation', '©lyr': '@lyrics', covr: '@pic', '©con': 'conductor',
    '©st3': 'subtitle', '©pub': 'label', desc: 'Description', ldes: 'Long description', '©wrk': 'Work', '©mvn': 'Movement',
    rtng: 'Content rating', purd: 'Purchase date' };
  // iTunes Store and sorting bookkeeping, not worth showing.
  const MP4_SKIP = /^(so..|apID|ownr|cnID|atID|plID|geID|sfID|cmID|akID|stik|pgap|hdvd|tv..|xid |flvr|pcst|catg|keyw|egid|purl|shwm|©mvi|©mvc)$/;
  const AOT = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC', 23: 'AAC-LD', 29: 'HE-AAC v2', 39: 'AAC-ELD', 42: 'xHE-AAC' };
  const MP4_CODECS = { 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC', '.mp3': 'MP3', twos: 'PCM', sowt: 'PCM', lpcm: 'PCM' };
  const RIFF_INFO = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre', ICMT: 'comment', ICOP: 'copyright',
    ISFT: 'encoder', ITRK: 'track', IPRT: 'track', IMUS: 'composer', IWRI: 'lyricist', ILNG: 'language', IENG: 'Engineer',
    ISRC: 'Source', IKEY: 'Keywords' };
  const WAV_CODECS = { 1: 'PCM', 2: 'ADPCM', 3: 'PCM (floating point)', 6: 'A-law', 7: 'µ-law', 0x11: 'IMA ADPCM', 0x55: 'MP3' };
  const ADTS_HZ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const MPEG_HZ = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const MPEG_KBPS = {
    v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    v2l2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'];
  const le32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const strict = new TextDecoder('utf-8', { fatal: true });
  const anyText = b => { try { return strict.decode(b); } catch { return latin1.decode(b); } };
  const ALL = { has: () => true };  // every ID3 frame

  // Everything a song's file says about itself, for the song details sheet:
  //   tags: [[label, value]] in FIELDS order · more: [[name, value]], the rest, as the file names them
  //   fmt: short format (MP3, AAC, FLAC…) · codec, container: the long names · kbps, vbr · hz · ch, mode · bits
  //   dur: seconds · encoder · tagType: ['ID3v2.3', …] · pic: {mime, size} or null · lyrics: 'timed', 'plain' or ''
  //   title, artist, album, year: for the lines under a song
  // `dur` (seconds, if known) gives the bitrate when the file doesn't say how long it is.
  async function details(blob, { dur = 0 } = {}) {
    const out = { fmt: '', codec: '', container: '', kbps: 0, vbr: false, hz: 0, ch: 0, mode: '', bits: 0, dur: 0,
                  encoder: '', vendor: '', tagType: [], pic: null, lyrics: '' };
    const known = new Map(), more = [];
    // Keeps one tag. A second value for a named field goes with the rest; `fill` only fills gaps (ID3v1).
    const put = (key, val, fill) => {
      if (key === '@pic') { out.pic ||= val; return; }
      if (key === '@lyrics') {
        const timed = val === 'timed' || /\[\d+:\d\d/.test(val);
        if (val && (timed || !out.lyrics)) out.lyrics = timed ? 'timed' : 'plain';
        return;
      }
      let s = String(val ?? '').replace(/\0+$/, '').replace(/\0/g, ' / ').replace(/[﻿￾]/g, '').trim();
      if (!s) return;
      if (s.length > 2000) s = s.slice(0, 2000) + '…';
      if (key[0] === '@') { known.set(key, s); return; }
      if (key === 'genre') s = s.split(' / ').map(g => {
        const m = g.match(/^\((\d+)\)(.*)$/);
        return m ? m[2] || ID3V1[m[1]] || g : /^\d+$/.test(g) ? ID3V1[g] || g : g;
      }).join(' / ');
      if (key === 'track' || key === 'disc') {
        s = s.replace(/^0*(\d+)\s*\/\s*0*(\d+)$/, '$1 of $2').replace(/^0+(?=\d)/, '');
        if (/^0( of|$)/.test(s)) return;
      }
      if (key === 'bpm' && !(+s > 0)) return;
      if (key === 'compilation') { if (!/^(1|yes|true)$/i.test(s)) return; s = 'Yes'; }
      if (key === 'encoder') { out.encoder ||= s; return; }
      if (FIELD.has(key)) {
        const had = known.get(key);
        if (!had) return void known.set(key, s);
        if (fill || had === s) return;
        key = FIELD.get(key);
      } else if (fill) return;
      if (more.length < 100 && !more.some(([k, v]) => k === key && v === s)) more.push([key, s]);
    };

    const head = await bytes(blob, 0, 12), magic = str4(head, 0);
    try {
      if (magic === 'fLaC') await flacInfo(blob, put, out);
      else if (magic === 'OggS') await oggInfo(blob, put, out);
      else if (str4(head, 4) === 'ftyp') {
        out.container = /^M4[ABP]/.test(str4(head, 8)) ? str4(head, 8).trim() : 'MP4';
        await mp4Info(blob, put, out);
      } else if (magic === 'RIFF' && str4(head, 8) === 'WAVE') await wavInfo(blob, put, out);
      else {
        let start = 0;
        if (magic.startsWith('ID3')) {
          start = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
          await id3Info(blob, put, out).catch(() => {});
        }
        await mpegInfo(blob, start, out).catch(() => {});
        await id3v1Info(blob, put, out);
      }
    } catch {}

    if (!out.dur) out.dur = dur;
    if (!out.kbps && out.dur) out.kbps = blob.size * 8 / out.dur / 1000;
    out.kbps = Math.round(out.kbps);
    out.encoder ||= out.vendor;
    for (const [k, n] of [['track', '@tracks'], ['disc', '@discs']])
      if (known.has(k) && known.has(n) && !known.get(k).includes(' of ')) known.set(k, known.get(k) + ' of ' + known.get(n));
    out.tags = FIELDS.filter(([k]) => known.has(k)).map(([k, label]) => [label, known.get(k)]);
    out.more = more;
    for (const k of ['title', 'artist', 'album']) out[k] = known.get(k) || '';
    out.year = ((known.get('year') || '').match(/\d{4}/) || [''])[0];
    delete out.vendor;
    return out;
  }

  // MP3 (and WAV's id3 chunk): every text frame, the comment, rating, links, and whether there's a
  // picture and lyrics.
  async function id3Info(blob, put, out) {
    const h = await bytes(blob, 0, 10);
    out.tagType.push('ID3v2.' + h[3]);
    await id3frames(blob, ALL, (id, d) => {
      if (!d.length) return;
      if (id === 'TXXX' || id === 'TXX') {
        const [k, ...v] = id3text(d).split('\0');
        if (!/^itun/i.test(k)) put(named(k || 'User text'), v.join('\0'));
      } else if (id === 'COMM' || id === 'COM') {
        const enc = d[0], p = skipStr(d, 4, enc), k = decodeAs(d.subarray(4, p), enc);
        if (!/^itun/i.test(k)) put(k && !/^(comment|description)$/i.test(k) ? `Comment (${k})` : 'comment', decodeAs(d.subarray(p), enc));
      } else if (id === 'USLT' || id === 'ULT') put('@lyrics', uslt(d));
      else if (id === 'SYLT' || id === 'SLT') put('@lyrics', 'timed');
      else if (id === 'APIC' || id === 'PIC') put('@pic', { mime: latin1.decode(id === 'PIC' ? d.subarray(1, 4) : d.subarray(1, d.indexOf(0, 1))), size: d.length });
      else if (id === 'POPM' || id === 'POP') {
        const z = d.indexOf(0), r = z >= 0 ? d[z + 1] : 0;  // 1–255, as Windows Media Player and others write it
        if (r) put('rating', '★'.repeat(r < 32 ? 1 : r < 96 ? 2 : r < 160 ? 3 : r < 224 ? 4 : 5));
      } else if (id === 'WXXX' || id === 'WXX') put('url', latin1.decode(d.subarray(skipStr(d, 1, d[0]))));
      else if (id[0] === 'W') put('url', latin1.decode(d));
      else if (id[0] === 'T' && !/^(TLEN|TLE|TSIZ|TSI)$/.test(id)) put(ID3_NAMES[id] || id, id3text(d));
    });
  }

  async function id3v1Info(blob, put, out) {
    if (blob.size < 128) return;
    const b = await bytes(blob, blob.size - 128, blob.size);
    if (latin1.decode(b.subarray(0, 3)) !== 'TAG') return;
    const s = (o, n) => latin1.decode(b.subarray(o, o + n)).split('\0')[0], v11 = b[125] === 0 && b[126];
    out.tagType.push('ID3v1');
    put('title', s(3, 30), 1); put('artist', s(33, 30), 1); put('album', s(63, 30), 1); put('year', s(93, 4), 1);
    put('comment', s(97, v11 ? 28 : 30), 1);
    if (v11) put('track', b[126], 1);
    put('genre', ID3V1[b[127]], 1);
  }

  // An MPEG audio frame header at b[i]: {ver, layer, kbps, hz, spf, len, mode}, or null if there isn't one.
  function mpegFrame(b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = b[i + 1] >> 3 & 3, layer = 4 - (b[i + 1] >> 1 & 3), bi = b[i + 2] >> 4, si = b[i + 2] >> 2 & 3;
    if (ver === 1 || layer === 4 || !bi || bi === 15 || si === 3) return null;
    const kbps = MPEG_KBPS[ver === 3 ? 'v1l' + layer : 'v2l' + (layer === 1 ? 1 : 2)][bi];
    const hz = MPEG_HZ[ver][si], spf = layer === 1 ? 384 : layer === 3 && ver !== 3 ? 576 : 1152, pad = b[i + 2] >> 1 & 1;
    const len = layer === 1 ? ((12 * kbps * 1000 / hz | 0) + pad) * 4 : (spf / 8 * kbps * 1000 / hz | 0) + pad;
    return { ver, layer, kbps, hz, spf, len, mode: b[i + 3] >> 6 };
  }

  // MP3 (and MP2, and AAC in ADTS): the first real frame after the tags, checked against the one after it.
  // A Xing, Info or VBRI header there gives the length and the average bitrate, and LAME's the encoder.
  async function mpegInfo(blob, start, out) {
    const b = await bytes(blob, start, start + 65536);
    for (let i = 0; i + 8 <= b.length; i++) {
      if (b[i] !== 0xff) continue;
      if ((b[i + 1] & 0xf6) === 0xf0 && ADTS_HZ[b[i + 2] >> 2 & 15]) {  // ADTS: 12 sync bits, layer 0
        const len = (b[i + 3] & 3) << 11 | b[i + 4] << 3 | b[i + 5] >> 5;
        if (len > 7 && (i + len + 2 > b.length || b[i + len] === 0xff && (b[i + len + 1] & 0xf6) === 0xf0)) {
          out.fmt = 'AAC'; out.codec = (AOT[(b[i + 2] >> 6) + 1] || 'AAC') + ' (ADTS)';
          out.hz = ADTS_HZ[b[i + 2] >> 2 & 15]; out.ch = (b[i + 2] & 1) << 2 | b[i + 3] >> 6;
          return;
        }
      }
      const f = mpegFrame(b, i);
      if (!f) continue;
      const next = i + f.len + 4 <= b.length ? mpegFrame(b, i + f.len) : f;
      if (!next || next.hz !== f.hz || next.layer !== f.layer) continue;
      out.fmt = 'MP' + f.layer;
      out.codec = `${out.fmt} (MPEG-${{ 3: '1', 2: '2', 0: '2.5' }[f.ver]} Layer ${['', 'I', 'II', 'III'][f.layer]})`;
      out.hz = f.hz; out.mode = MODES[f.mode]; out.ch = f.mode === 3 ? 1 : 2; out.kbps = f.kbps;
      const x = i + 4 + (f.ver === 3 ? (f.mode === 3 ? 17 : 32) : (f.mode === 3 ? 9 : 17));
      let frames = 0, size = 0;
      if (x + 8 <= b.length && /^(Xing|Info)$/.test(str4(b, x))) {
        const fl = u32(b, x + 4);
        let p = x + 8;
        if (fl & 1) { frames = u32(b, p); p += 4; }
        if (fl & 2) { size = u32(b, p); p += 4; }
        if (fl & 4) p += 100;
        if (fl & 8) p += 4;
        const enc = latin1.decode(b.subarray(p, p + 9));
        // nine characters, so "Lavc63.1.102" comes out as "Lavc63.1."
        if (/^(LAME|Lavc|Lavf|GOGO|L3\.99)/.test(enc)) out.vendor = enc.replace(/[^\x20-\x7e]/g, '').trim().replace(/\.$/, '');
        out.vbr = str4(b, x) === 'Xing';  // Info: the same header on a constant-bitrate file
      } else if (i + 54 <= b.length && str4(b, i + 36) === 'VBRI') {
        size = u32(b, i + 46); frames = u32(b, i + 50); out.vbr = true;
      }
      const audio = size || blob.size - start - i;
      out.dur = frames ? frames * f.spf / f.hz : audio * 8 / (f.kbps * 1000);
      if (out.vbr && out.dur) out.kbps = audio * 8 / out.dur / 1000;
      return;
    }
  }

  // FLAC: the stream info block (sample rate, channels, bit depth, length), the tags and the pictures.
  async function flacInfo(blob, put, out) {
    out.fmt = 'FLAC'; out.codec = 'FLAC (lossless)';
    let audio = 0;
    for (let p = 4, i = 0; i < 128 && p + 4 <= blob.size; i++) {
      const h = await bytes(blob, p, p + 4), type = h[0] & 0x7f, len = h[1] << 16 | h[2] << 8 | h[3];
      if (type === 0) {
        const s = await bytes(blob, p + 4, p + 22), n = (s[13] & 15) * 4294967296 + u32(s, 14);
        out.hz = s[10] << 12 | s[11] << 4 | s[12] >> 4; out.ch = (s[12] >> 1 & 7) + 1; out.bits = ((s[12] & 1) << 4 | s[13] >> 4) + 1;
        if (out.hz && n) out.dur = n / out.hz;
      } else if (type === 4) {
        out.tagType.push('Vorbis comments');
        vorbisInfo(await bytes(blob, p + 4, p + 4 + len), 0, put, out);
      } else if (type === 6) {
        const b = await bytes(blob, p + 4, p + 4 + Math.min(len, 256));
        put('@pic', { mime: latin1.decode(b.subarray(8, 8 + Math.min(u32(b, 4), 64))), size: len });
      }
      p += 4 + len;
      if (h[0] & 0x80) { audio = p; break; }
    }
    if (out.dur && audio) out.kbps = (blob.size - audio) * 8 / out.dur / 1000;
  }

  // Every Vorbis comment, and the vendor string (the encoder) before them.
  function vorbisInfo(b, p, put, out) {
    const vlen = le32(b, p);
    out.vendor = utf8.decode(b.subarray(p + 4, p + 4 + vlen)).trim();
    p += 4 + vlen;
    for (let n = le32(b, p), i = 0, q = p + 4; i < n && q + 4 <= b.length; i++) {
      const len = le32(b, q), s = utf8.decode(b.subarray(q + 4, q + 4 + len)), eq = s.indexOf('=');
      q += 4 + len;
      if (eq < 1) continue;
      const key = named(s.slice(0, eq));
      put(key, key === '@pic' ? { mime: '', size: (len - eq - 1) * 3 / 4 | 0 } : s.slice(eq + 1));
    }
  }

  // Ogg Vorbis and Opus: the first page says how it's coded, the last page how long it is.
  async function oggInfo(blob, put, out) {
    const b = await bytes(blob, 0, 1 << 17), s = latin1.decode(b);
    let i, rate = 0, skip = 0, opus = false;
    out.container = 'Ogg';
    if ((i = s.indexOf('\x01vorbis')) >= 0) {
      out.fmt = out.codec = 'Vorbis'; out.ch = b[i + 11]; out.hz = rate = le32(b, i + 12);
      const nominal = le32(b, i + 20) | 0;
      if (nominal > 0) out.kbps = nominal / 1000;
    } else if ((i = s.indexOf('OpusHead')) >= 0) {
      out.fmt = out.codec = 'Opus'; opus = true; out.ch = b[i + 9]; skip = b[i + 10] | b[i + 11] << 8;
      out.hz = le32(b, i + 12) || 48000; rate = 48000;
    } else if (s.includes('\x7fFLAC')) { out.fmt = 'FLAC'; out.codec = 'FLAC (lossless)'; }
    const c = s.indexOf(opus ? 'OpusTags' : '\x03vorbis');
    if (c >= 0) { out.tagType.push('Vorbis comments'); vorbisInfo(b, c + (opus ? 8 : 7), put, out); }
    const tail = await bytes(blob, Math.max(0, blob.size - 65536), blob.size), at = latin1.decode(tail).lastIndexOf('OggS');
    if (rate && at >= 0 && at + 14 <= tail.length) {
      const g = le32(tail, at + 6) + le32(tail, at + 10) * 4294967296;
      if (g > skip && g < 2 ** 50) out.dur = (g - skip) / rate;
    }
    if (out.dur) out.kbps = blob.size * 8 / out.dur / 1000;  // the true average beats the nominal rate
  }

  // M4A: the iTunes tags, then the sound track's codec, sample rate, channels and length.
  async function mp4Info(blob, put, out) {
    const { moov, items } = await mp4items(blob);
    if (!moov) return;
    if (items.length) out.tagType.push('iTunes (MP4)');
    for (const item of items) {
      let key = MP4_NAMES[item.type];
      if (item.type === '----') {  // free-form, e.g. com.apple.iTunes:LABEL
        const n = box(moov, 'name', item.from, item.to), name = n ? utf8.decode(moov.subarray(n.from + 4, n.to)) : '';
        if (!name || /^itun/i.test(name)) continue;
        key = named(name);
      } else if (!key) {
        if (MP4_SKIP.test(item.type)) continue;
        key = item.type.replace('©', '');
      }
      for (const d of boxes(moov, item.from, item.to)) {
        if (d.type !== 'data') continue;
        const kind = u32(moov, d.from) & 0xffffff, v = moov.subarray(d.from + 8, d.to);
        if (key === '@pic') put(key, { mime: kind === 14 ? 'PNG' : 'JPEG', size: v.length });
        else if (item.type === 'trkn' || item.type === 'disk') {
          const n = v[2] << 8 | v[3], of = v[4] << 8 | v[5];
          if (v.length >= 6 && n) put(key, n + (of ? '/' + of : ''));
        } else if (item.type === 'gnre') put(key, ID3V1[(v[0] << 8 | v[1]) - 1]);
        else if (item.type === 'rtng') put(key, ['', 'Explicit', 'Clean', '', 'Explicit'][v[0]]);
        else if (kind === 1) put(key, utf8.decode(v));
        else if (kind === 2) put(key, utf16be.decode(v));
        else if ((kind === 0 || kind === 21 || kind === 22) && v.length && v.length <= 4) put(key, v.reduce((n, x) => n * 256 + x, 0));
      }
    }
    for (const trak of boxes(moov, 0, moov.length)) {
      if (trak.type !== 'trak') continue;
      const mdia = box(moov, 'mdia', trak.from, trak.to), hdlr = mdia && box(moov, 'hdlr', mdia.from, mdia.to);
      if (!hdlr || str4(moov, hdlr.from + 8) !== 'soun') continue;
      const mdhd = box(moov, 'mdhd', mdia.from, mdia.to);
      let scale = 0;
      if (mdhd) {
        const m = mdhd.from, v1 = moov[m] === 1;
        scale = u32(moov, m + (v1 ? 20 : 12));
        const len = v1 ? u32(moov, m + 24) * 4294967296 + u32(moov, m + 28) : u32(moov, m + 16);
        if (scale) out.dur = len / scale;
      }
      const minf = box(moov, 'minf', mdia.from, mdia.to), stbl = minf && box(moov, 'stbl', minf.from, minf.to);
      const stsd = stbl && box(moov, 'stsd', stbl.from, stbl.to), e = stsd && boxes(moov, stsd.from + 8, stsd.to).next().value;
      if (!e) break;
      // A sound entry: 8 reserved bytes, version, revision, vendor, channels, sample size, two more, the rate (16.16).
      const at = e.from, ver = moov[at + 8] << 8 | moov[at + 9], kids = at + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
      out.ch = moov[at + 16] << 8 | moov[at + 17];
      out.hz = u32(moov, at + 24) >>> 16;
      if (out.hz < 8000) out.hz = scale;  // version 2 entries keep the rate elsewhere; the track's timescale is it
      if (e.type === 'mp4a') {
        const es = box(moov, 'esds', kids, e.to), d = es && esds(moov, es.from + 4);
        const mp3 = d && (d.oti === 0x69 || d.oti === 0x6b);
        out.fmt = mp3 ? 'MP3' : 'AAC'; out.codec = mp3 ? 'MP3' : AOT[d?.aot] || 'AAC';
      } else if (e.type === 'alac') {
        out.fmt = 'ALAC'; out.codec = 'Apple Lossless (ALAC)';
        const c = box(moov, 'alac', kids, e.to);
        if (c) { out.bits = moov[c.from + 9]; out.ch = moov[c.from + 13] || out.ch; out.hz = u32(moov, c.from + 24) || out.hz; }
      } else out.fmt = out.codec = MP4_CODECS[e.type] || e.type.trim();
      break;
    }
    // The cover and tags live in moov, so the rest of the file is (about) the sound.
    if (out.dur) out.kbps = (blob.size - moov.length) * 8 / out.dur / 1000;
  }

  // The MPEG-4 descriptors in an esds box: the object type, and the AAC profile from the decoder setup.
  function esds(b, p) {
    const desc = () => {
      const tag = b[p++];
      for (let i = 0; i < 4 && b[p++] & 0x80; i++);
      return tag;
    };
    if (desc() !== 3) return null;
    p += 2;
    const fl = b[p++];
    if (fl & 0x80) p += 2;
    if (fl & 0x40) p += 1 + b[p];
    if (fl & 0x20) p += 2;
    if (desc() !== 4) return null;
    const oti = b[p];
    p += 13;
    let aot = 0;
    if (desc() === 5) { aot = b[p] >> 3; if (aot === 31) aot = 32 + ((b[p] & 7) << 3 | b[p + 1] >> 5); }
    return { oti, aot };
  }

  // WAV: the fmt chunk (coding, channels, rate, bit depth), the length from the data chunk, and tags from a
  // LIST INFO chunk or an id3 chunk.
  async function wavInfo(blob, put, out) {
    out.container = 'WAV'; out.fmt = 'WAV';
    let rate = 0;
    for (let p = 12, i = 0; i < 64 && p + 8 <= blob.size; i++) {
      const h = await bytes(blob, p, p + 8), id = str4(h, 0), len = le32(h, 4);
      if (id === 'fmt ') {
        const f = await bytes(blob, p + 8, p + 8 + Math.min(len, 40));
        let tag = f[0] | f[1] << 8;
        if (tag === 0xfffe && f.length >= 26) tag = f[24] | f[25] << 8;  // extensible: the real format's in the subformat
        out.codec = WAV_CODECS[tag] || 'Format ' + tag;
        out.ch = f[2] | f[3] << 8; out.hz = le32(f, 4); rate = le32(f, 8); out.kbps = rate * 8 / 1000;
        if (tag === 1 || tag === 3) out.bits = f[14] | f[15] << 8;
      } else if (id === 'data') {
        if (rate) out.dur = Math.min(len, blob.size - p - 8) / rate;
      } else if (id === 'LIST') {
        const l = await bytes(blob, p + 8, p + 8 + Math.min(len, 1 << 20));
        if (str4(l, 0) === 'INFO') {
          out.tagType.push('RIFF INFO');
          for (let q = 4; q + 8 <= l.length;) {
            const n = le32(l, q + 4);
            put(RIFF_INFO[str4(l, q)] || str4(l, q), anyText(l.subarray(q + 8, q + 8 + n)));
            q += 8 + n + (n & 1);
          }
        }
      } else if (id === 'id3 ' || id === 'ID3 ') await id3Info(blob.slice(p + 8, p + 8 + len), put, out).catch(() => {});
      p += 8 + len + (len & 1);
    }
  }

  global.Vibe = { VIBES, read, classify, energy, genreName, cover, lyrics, details };
})(self);
