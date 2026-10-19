/* Folder Player — ambience synthesizer.
 *
 * Renders each built-in ambience as a stereo loop that repeats without a seam:
 * every source (noise, modulation curves, one-off events) is periodic over the
 * loop length, events that run past the end wrap to the start, and filters are
 * run over the loop's tail first so their state at sample 0 matches the end.
 *
 * Runs as a Web Worker ({job, id, sr} in, {job, ch: [left, right]} out), or on
 * the main thread through self.AmbienceSynth when workers are unavailable.
 */
(function (global) {
  'use strict';
  const TAU = 2 * Math.PI;

  function rng(seed) {
    let s = Math.imul(seed, 2654435761) | 0 || 1;
    const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    for (let i = 0; i < 8; i++) next();
    return next;
  }

  // Shared state for one render: loop length n (a multiple of 64), seeded randomness,
  // a periodic white-noise table read at different offsets, and the two output
  // channels, which hold the event layer until render() runs over them.
  function kit(sr, seconds, seed) {
    const n = Math.round(seconds * sr / 64) * 64, rand = rng(seed), W = new Float32Array(n);
    for (let i = 0; i < n; i++) W[i] = rand() * 2 - 1;
    return {
      sr, n, rand, ch: [new Float32Array(n), new Float32Array(n)],
      rnd: (a, b) => a + (b - a) * rand(),
      at: () => (rand() * n) | 0,
      noise: (i, off) => { const j = i + off; return W[j < n ? j : j - n]; },
    };
  }

  // ---- building blocks -------------------------------------------------------

  // Zero-delay state-variable filter (Simper); stable when swept per sample.
  // run() returns lowpass and also sets .lp, .bp (unity peak) and .hp.
  function svf(sr, f, q) {
    let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;
    const s = {
      lp: 0, bp: 0, hp: 0,
      set(f, q) {
        const g = Math.tan(Math.PI * Math.min(f, sr * 0.45) / sr);
        k = 1 / q; a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
      },
      run(x) {
        const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        s.lp = v2; s.bp = k * v1; s.hp = x - k * v1 - v2;
        return v2;
      },
    };
    s.set(f, q);
    return s;
  }

  function pinkF() {
    let b0 = 0, b1 = 0, b2 = 0;
    return w => {
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      return (b0 + b1 + b2 + w * 0.1848) * 0.3;
    };
  }

  function brownF() { let b = 0; return w => (b = (b + 0.02 * w) / 1.02) * 3.5; }

  // Smooth random curve between lo and hi with `knots` turning points per loop.
  // Periodic for any index, so callers can read it at i + offset.
  function curve(k, knots, lo, hi) {
    knots = Math.max(2, knots);
    const v = Array.from({ length: knots }, () => k.rnd(lo, hi)), s = knots / k.n;
    return i => {
      const p = i * s, a = p | 0, t = p - a, u = t * t * (3 - 2 * t), v0 = v[a % knots];
      return v0 + (v[(a + 1) % knots] - v0) * u;
    };
  }

  // Start samples for events roughly `every` seconds apart; the gaps sum to exactly
  // one loop so the rhythm holds across the wrap.
  function times(k, every, jitter) {
    const m = Math.max(1, Math.round(k.n / (every * k.sr)));
    const gaps = Array.from({ length: m }, () => 1 + k.rnd(-jitter, jitter)), sum = gaps.reduce((a, b) => a + b);
    let acc = k.rand() * k.n;
    return gaps.map(g => { const t = Math.floor(acc) % k.n; acc += g / sum * k.n; return t; });
  }

  const gains = p => [Math.min(1, 1 - p), Math.min(1, 1 + p)];
  const wrap = (k, i) => i < k.n ? i : i - k.n;

  // Struck resonance: a decaying sine (recursive, no trig per sample). Keep tau short
  // (a cycle or two) for a knock or thump rather than a ringing note.
  function ping(k, t, f, tau, amp, gl, gr) {
    const w = TAU * f / k.sr, r = Math.exp(-1 / (tau * k.sr)), c = 2 * r * Math.cos(w), r2 = r * r, [L, R] = k.ch;
    const len = Math.min(k.n - 1, Math.ceil(tau * k.sr * 5));
    let y1 = 0, y2 = 0, x = amp * Math.sin(w);
    for (let j = 0; j < len; j++) {
      const y = c * y1 - r2 * y2 + x; x = 0; y2 = y1; y1 = y;
      const i = wrap(k, t + j); L[i] += y * gl; R[i] += y * gr;
    }
  }

  // Noise burst with a near-instant attack, decaying with time constant tau,
  // band-limited between lo and hi Hz (one-pole filters, fresh per burst).
  function burst(k, t, tau, amp, lo, hi, gl, gr) {
    const { sr } = k, [L, R] = k.ch, len = Math.min(k.n - 1, Math.max(4, Math.round(tau * sr * 4)));
    const d = Math.exp(-1 / (tau * sr)), ah = 1 - Math.exp(-TAU * hi / sr), al = 1 - Math.exp(-TAU * lo / sr), att = 0.0003 * sr;
    let e = amp, y = 0, z = 0;
    for (let j = 0; j < len; j++) {
      y += ah * (k.rand() * 2 - 1 - y);
      z += al * (y - z);
      const s = (y - z) * e * Math.min(1, j / att), i = wrap(k, t + j);
      L[i] += s * gl; R[i] += s * gr; e *= d;
    }
  }

  // Short bright click of differentiated noise.
  function crackle(k, t, dur, amp, gl, gr) {
    const len = Math.max(2, Math.round(dur * k.sr)), [L, R] = k.ch;
    let prev = 0;
    for (let j = 0; j < len; j++) {
      const w = k.rand() * 2 - 1, y = (w - prev) * amp * Math.exp(-4 * j / len); prev = w;
      const i = wrap(k, t + j); L[i] += y * gl; R[i] += y * gr;
    }
  }

  // A pitched note; freq(x) and env(x) take x = 0..1 across the note.
  function tone(k, t, dur, freq, env, gl, gr, harm = 0) {
    const len = Math.min(k.n - 1, Math.max(1, Math.round(dur * k.sr))), [L, R] = k.ch;
    let ph = 0;
    for (let j = 0; j < len; j++) {
      const x = j / len; ph += TAU * freq(x) / k.sr;
      const s = (Math.sin(ph) + harm * Math.sin(2 * ph)) * env(x), i = wrap(k, t + j);
      L[i] += s * gl; R[i] += s * gr;
    }
  }

  // Water bubble: a sine whose pitch rises as it decays (drips, brooks).
  function bubble(k, t, f, tau, rise, amp, gl, gr) {
    const len = Math.min(k.n - 1, Math.round(tau * 4 * k.sr)), d = Math.exp(-1 / (tau * k.sr)), [L, R] = k.ch;
    let ph = 0, e = amp;
    for (let j = 0; j < len; j++) {
      ph += TAU * f * (1 + rise * j / len) / k.sr;
      const s = Math.sin(ph) * e, i = wrap(k, t + j);
      L[i] += s * gl; R[i] += s * gr; e *= d;
    }
  }

  // Small Schroeder reverb: four damped combs into two allpasses.
  function reverb(sr, spread, fb) {
    const sc = sr / 44100, line = d => new Float32Array(Math.round((d + spread) * sc));
    const cb = [1116, 1188, 1277, 1356].map(line), cz = [0, 0, 0, 0], ci = [0, 0, 0, 0];
    const ab = [556, 341].map(line), ai = [0, 0];
    return x => {
      let s = 0;
      for (let c = 0; c < 4; c++) {
        const b = cb[c], y = b[ci[c]];
        cz[c] = y * 0.7 + cz[c] * 0.3; b[ci[c]] = x + cz[c] * fb;
        if (++ci[c] === b.length) ci[c] = 0;
        s += y;
      }
      s *= 0.25;
      for (let c = 0; c < 2; c++) {
        const b = ab[c], bo = b[ai[c]];
        b[ai[c]] = s + bo * 0.5; s = bo - s;
        if (++ai[c] === b.length) ai[c] = 0;
      }
      return s;
    };
  }

  const bell = x => Math.sin(Math.PI * x);
  const pluck = x => Math.min(1, x * 12) * (1 - x) * (1 - x);
  const flat = x => Math.min(1, x * 10, (1 - x) * 10);

  // Runs fn over the loop's last `warm` seconds (discarded) so every filter holds the
  // state it will have at the end, then over the whole loop, writing in place.
  // fn(i, o) receives o = [left, right] pre-filled with the event layer at i.
  function render(k, warm, fn) {
    const [L, R] = k.ch, o = [0, 0], n = k.n;
    for (let i = n - Math.min(n, Math.round(warm * k.sr)); i < n; i++) { o[0] = L[i]; o[1] = R[i]; fn(i, o); }
    for (let i = 0; i < n; i++) { o[0] = L[i]; o[1] = R[i]; fn(i, o); L[i] = o[0]; R[i] = o[1]; }
  }

  // Scale to a target RMS (but never so far that peaks pass 1.6).
  function level(k, rms) {
    const [L, R] = k.ch;
    let e = 0, p = 1e-9;
    for (let i = 0; i < k.n; i++) {
      const a = L[i], b = R[i]; e += a * a + b * b;
      const m = a < 0 ? -a : a, q = b < 0 ? -b : b;
      if (m > p) p = m;
      if (q > p) p = q;
    }
    const g = Math.min(rms / Math.sqrt(e / (2 * k.n) + 1e-12), 1.6 / p);
    for (let i = 0; i < k.n; i++) { L[i] *= g; R[i] *= g; }
  }

  // Round off anything past 0.6 so the few loudest moments never clip.
  function soften(k) {
    const T = 0.6, C = 0.35, s = x => x > T ? T + C * Math.tanh((x - T) / C) : x < -T ? -T - C * Math.tanh((-x - T) / C) : x;
    for (const ch of k.ch) for (let i = 0; i < k.n; i++) ch[i] = s(ch[i]);
    return k.ch;
  }

  const finish = (k, rms) => { level(k, rms); return soften(k); };

  // ---- rain ------------------------------------------------------------------

  // Rain bed: soft ticks of far-off drops, closer splats, and a hiss under them.
  // Writes the drops; returns the per-sample hiss for render().
  function rainLayer(k, o) {
    const { sr } = k, secs = k.n / sr;
    for (let j = 0, m = secs * o.ticks; j < m; j++) {
      const [gl, gr] = gains(k.rnd(-1, 1));
      burst(k, k.at(), k.rnd(0.0003, 0.0012), Math.pow(k.rand(), 2.5) * o.tick, 900, o.tickHi, gl, gr);
    }
    for (let j = 0, m = secs * o.splats; j < m; j++) {
      const [gl, gr] = gains(k.rnd(-0.9, 0.9));
      burst(k, k.at(), k.rnd(0.002, 0.008), Math.pow(k.rnd(0.35, 1), 1.5) * o.splat, 250, o.splatHi, gl, gr);
    }
    const swell = curve(k, Math.round(secs / 4), 1 - o.gust, 1);
    const ch = [0, 1].map(() => ({
      off: k.at(), off2: k.at(), pink: pinkF(), brown: brownF(),
      hiss: svf(sr, o.hissF, 0.5), muff: svf(sr, o.muffle, 0.6), body: svf(sr, 250, 0.6),
    }));
    return (i, out) => {
      const s = swell(i);
      for (let c = 0; c < 2; c++) {
        const v = ch[c];
        v.hiss.run(v.pink(k.noise(i, v.off)));
        v.muff.run(v.hiss.bp);
        v.body.run(v.brown(k.noise(i, v.off2)));
        out[c] += (v.muff.lp * o.hiss + v.body.lp * o.body) * s;
      }
    };
  }

  // A drop landing in a puddle: the tap, then the rising "plip".
  function drip(k, t, f, a, gl, gr) {
    burst(k, t, 0.0008, a * 0.5, 1500, 8000, gl, gr);
    bubble(k, wrap(k, t + 40), f, k.rnd(0.018, 0.03), k.rnd(0.5, 1), a * 0.35, gl, gr);
  }

  // Water dripping off a gutter: nearly steady, with the odd double drop.
  function gutter(k, every, pan, amp, pitch) {
    const [gl, gr] = gains(pan), { sr, n } = k;
    for (let s = k.rnd(0, every); s < n / sr; s += every * k.rnd(0.7, 1.35)) {
      const t = Math.round(s * sr), a = amp * k.rnd(0.6, 1);
      drip(k, t, pitch * k.rnd(0.85, 1.15), a, gl, gr);
      if (k.rand() < 0.2) drip(k, wrap(k, t + Math.round(k.rnd(0.09, 0.2) * sr)), pitch * k.rnd(0.9, 1.25), a * 0.5, gl, gr);
    }
  }

  // Rain heard from indoors: drops on the window, a muffled hiss, gutters dripping.
  function rain(sr) {
    const k = kit(sr, 48, 101);
    const bed = rainLayer(k, { ticks: 160, tick: 1, tickHi: 5000, splats: 14, splat: 0.7, splatHi: 3500, hissF: 1800, muffle: 4000, hiss: 0.22, body: 0.2, gust: 0.25 });
    gutter(k, 0.9, 0.55, 1, 1150);
    gutter(k, 1.7, -0.65, 0.35, 1450);
    const rl = reverb(sr, 0, 0.7), rr = reverb(sr, 23, 0.7);
    render(k, 3, (i, o) => {
      bed(i, o);
      const l = o[0], r = o[1];
      o[0] = l + rl(l) * 0.12; o[1] = r + rr(r) * 0.12;
    });
    return finish(k, 0.075);
  }

  // Sitting in a parked car: drumming on the roof, ticks on the windshield,
  // fat drops off the trees, and the outside rain muffled by the cabin.
  function car(sr) {
    const k = kit(sr, 40, 111), secs = k.n / sr;
    for (let j = 0, m = secs * 90; j < m; j++) {
      const t = k.at(), [gl, gr] = gains(k.rnd(-1, 1)), a = Math.pow(k.rand(), 2);
      ping(k, t, k.rnd(150, 330), k.rnd(0.002, 0.005), a * 0.25, gl, gr);
      burst(k, t, k.rnd(0.0005, 0.0015), a * 0.35, 400, 2500, gl, gr);
    }
    for (let j = 0, m = secs * 30; j < m; j++) {
      const [gl, gr] = gains(k.rnd(-0.45, 0.45));
      burst(k, k.at(), k.rnd(0.0008, 0.003), Math.pow(k.rand(), 2) * 0.8, 1500, 6500, gl, gr);
    }
    for (let j = 0, m = Math.round(secs * 0.7); j < m; j++) {
      const t = k.at(), [gl, gr] = gains(k.rnd(-0.8, 0.8)), a = k.rnd(0.5, 1);
      ping(k, t, k.rnd(90, 150), k.rnd(0.008, 0.016), a * 0.8, gl, gr);
      burst(k, t, 0.003, a * 0.8, 200, 2000, gl, gr);
    }
    const swell = curve(k, 10, 0.8, 1);
    const ch = [0, 1].map(() => ({ off: k.at(), off2: k.at(), pink: pinkF(), brown: brownF(), out: svf(sr, 700, 0.6), cabin: svf(sr, 110, 0.7) }));
    render(k, 3, (i, o) => {
      const s = swell(i);
      for (let c = 0; c < 2; c++) {
        const v = ch[c];
        v.out.run(v.pink(k.noise(i, v.off)));
        v.cabin.run(v.brown(k.noise(i, v.off2)));
        o[c] += (v.out.lp * 0.12 + v.cabin.lp * 0.06) * s;
      }
    });
    return finish(k, 0.08);
  }

  // One thunderclap peaking at `power` (0.25 far off … 1 right overhead): a crackling
  // split when close, then a rolling rumble.
  function thunder(k, t, power) {
    const { sr } = k, dur = k.rnd(8, 13), len = Math.round(dur * sr);
    const hits = [{ at: 0, a: 1, att: 0.03 + 0.4 * (1 - power), dec: k.rnd(1.2, 2.2) }];
    for (let j = 0, m = 3 + (k.rand() * 5 | 0); j < m; j++)
      hits.push({ at: k.rnd(0.2, dur * 0.6), a: k.rnd(0.25, 0.8), att: k.rnd(0.05, 0.4), dec: k.rnd(0.8, 2.8) });
    const roll = Array.from({ length: Math.ceil(dur / 0.09) + 2 }, () => k.rnd(0.3, 1));
    const cracks = power > 0.7 ? Array.from({ length: 4 + (k.rand() * 6 | 0) }, () => [k.rnd(0, 0.5), k.rnd(0.3, 1)]) : [];
    const out = [new Float32Array(len), new Float32Array(len)];
    const ch = [0, 1].map(() => ({
      br: brownF(), pk: pinkF(),
      deep: svf(sr, 70 + 90 * power, 0.7), body: svf(sr, 180 + 220 * power, 0.8), crack: svf(sr, 1800, 0.6),
    }));
    let e = 0, cr = 0;
    for (let j = 0; j < len; j++) {
      const s = j / sr;
      if ((j & 31) === 0) {
        e = 0;
        for (const h of hits) { const x = s - h.at; if (x > 0) e += h.a * (1 - Math.exp(-x / h.att)) * Math.exp(-x / h.dec); }
        const p = s / 0.09, q = p | 0;
        e *= (roll[q] + (roll[q + 1] - roll[q]) * (p - q)) * Math.min(1, (dur - s) / 2.5);
        cr = 0;
        for (const [at, a] of cracks) { const x = s - at; if (x > 0) cr += a * Math.exp(-x / 0.06); }
      }
      for (let c = 0; c < 2; c++) {
        const v = ch[c], w = k.rand() * 2 - 1;
        v.deep.run(v.br(w)); v.body.run(v.pk(w)); v.crack.run(w);
        out[c][j] = (v.deep.lp * 1.2 + v.body.bp * (0.3 + 0.4 * power)) * e + v.crack.hp * cr * 0.25;
      }
    }
    // Loudness comes from the clap's loudest quarter second, so a big one stands
    // well clear of the rain (the soft limiter catches the very top).
    let top = 1e-12, p = 1e-9;
    for (let j0 = 0, w = Math.round(sr / 4); j0 + w <= len; j0 += w) {
      let e = 0;
      for (let j = j0; j < j0 + w; j++) e += out[0][j] * out[0][j] + out[1][j] * out[1][j];
      top = Math.max(top, e / (2 * w));
    }
    for (const o of out) for (let j = 0; j < len; j++) p = Math.max(p, Math.abs(o[j]));
    const g = Math.min((0.06 + 0.3 * power) / Math.sqrt(top), 2 / p), pan = gains(k.rnd(-0.5, 0.5));
    for (let c = 0; c < 2; c++) {
      const dst = k.ch[c], src = out[c], gg = g * pan[c];
      for (let j = 0; j < len; j++) dst[wrap(k, t + j)] += src[j] * gg;
    }
  }

  function storm(sr) {
    const k = kit(sr, 80, 202);
    render(k, 3, rainLayer(k, { ticks: 320, tick: 1.1, tickHi: 7000, splats: 30, splat: 0.7, splatHi: 5000, hissF: 2200, muffle: 8000, hiss: 0.5, body: 0.6, gust: 0.4 }));
    level(k, 0.08);
    // Thunder now and then: distant rolls, and one heavy strike right overhead.
    const power = [1, 0.35, 0.6, 0.25];
    times(k, 20, 0.5).forEach((t, j) => thunder(k, t, power[j % power.length]));
    return soften(k);
  }

  // ---- sea, wind, water ------------------------------------------------------

  function waves(sr) {
    const k = kit(sr, 80, 303), { n } = k, CR = 64, m = n / CR, fr = sr / CR, secs = n / sr;
    // Control-rate envelopes per channel: loudness, brightness × loudness, foam.
    const env = () => [new Float32Array(m), new Float32Array(m)];
    const amp = env(), bri = env(), foam = env();
    // Breakers arrive at random (sometimes on top of each other, sometimes after a
    // lull), each with its own size, length and spot along the shore.
    for (let s = k.rnd(0, 3); s < secs; s += 1 + -Math.log(1 - k.rand()) * 4.5) {
      const far = k.rand(), A = k.rnd(0.35, 1) * (1 - 0.55 * far), rise = k.rnd(1.5, 4) * (1 + 0.6 * far);
      const wash = k.rnd(2.5, 6) * (1 + 0.4 * far), crash = k.rnd(0.4, 1.2), hi = 1 - 0.65 * far, g = gains(k.rnd(-0.85, 0.85));
      const c0 = Math.round(s * fr);
      for (let f = -Math.round(rise * fr), end = Math.round(wash * 4 * fr); f < end; f++) {
        const x = f / fr;
        let a, b, z;
        if (x < 0) { const u = 1 + x / rise, sm = u * u * (3 - 2 * u); a = 0.45 * sm * sm; b = 0.08 + 0.3 * sm * hi; z = 0; }
        else {
          a = 0.45 * Math.exp(-x / wash) + 0.55 * crash * (1 - Math.exp(-x / 0.06)) * Math.exp(-x / 0.8);
          b = (0.12 + 0.8 * Math.exp(-x / 0.6)) * hi;
          z = (1 - Math.exp(-x / 0.25)) * Math.exp(-x / (wash * 0.7)) * hi;
        }
        const idx = ((c0 + f) % m + m) % m;
        for (let c = 0; c < 2; c++) { const w = A * g[c]; amp[c][idx] += a * w; bri[c][idx] += a * b * w; foam[c][idx] += z * w; }
      }
    }
    // A steady roar of distant surf under it all; foam hiss with a fine grain to it.
    const surf = curve(k, 18, 0.4, 1), grain = curve(k, Math.round(secs * 18), 0.45, 1), gOff = Math.round(n / 3);
    const ch = [0, 1].map(() => ({
      off: k.at(), off2: k.at(), off3: k.at(), pink: pinkF(), pink2: pinkF(), brown: brownF(),
      body: svf(sr, 400, 0.55), deep: svf(sr, 300, 0.6), fizz: svf(sr, 3000, 0.7),
    }));
    render(k, 4, (i, o) => {
      const f = i / CR, q = f | 0, u = f - q, q1 = q + 1 === m ? 0 : q + 1, sv = surf(i);
      for (let c = 0; c < 2; c++) {
        const v = ch[c], A = amp[c][q] + (amp[c][q1] - amp[c][q]) * u;
        const B = bri[c][q] + (bri[c][q1] - bri[c][q]) * u, Z = foam[c][q] + (foam[c][q1] - foam[c][q]) * u;
        if ((i & 15) === 0) { const b = A > 1e-4 ? B / A : 0.1; v.body.set(150 + 3800 * b * b, 0.55); }
        v.body.run(v.pink(k.noise(i, v.off)));
        v.deep.run(v.brown(k.noise(i, v.off2)));
        v.fizz.run(v.pink2(k.noise(i, v.off3)));
        o[c] += v.body.lp * A + v.fizz.bp * Z * grain(i + c * gOff) * 0.5 + v.deep.lp * (0.25 + 0.25 * sv);
      }
    });
    return finish(k, 0.09);
  }

  function wind(sr) {
    const k = kit(sr, 45, 404), gust = curve(k, 16, 0, 1), flutter = curve(k, 150, 0.75, 1.25), whistle = curve(k, 10, 0, 1);
    const lag = Math.round(0.4 * sr);
    const ch = [0, 1].map(c => ({
      off: k.at(), off2: k.at(), pink: pinkF(), brown: brownF(), d: c * lag, g: 0, w: 0,
      band: svf(sr, 500, 0.8), tone: svf(sr, 700, 14), low: svf(sr, 120, 0.6),
    }));
    render(k, 4, (i, o) => {
      for (let c = 0; c < 2; c++) {
        const v = ch[c];
        if ((i & 15) === 0) {
          const x = gust(i + v.d);
          v.g = x * x * (3 - 2 * x); v.w = whistle(i + v.d);
          v.band.set(220 + 1100 * v.g, 0.8);
          v.tone.set(450 + 650 * v.w + 250 * v.g, 14);
        }
        v.band.run(v.pink(k.noise(i, v.off)));
        v.tone.run(k.noise(i, v.off2));
        v.low.run(v.brown(k.noise(i, v.off2)));
        o[c] += v.band.bp * (0.15 + 0.85 * v.g) * flutter(i + v.d) + v.tone.bp * 2.5 * v.g * v.g + v.low.lp * 0.5 * v.g;
      }
    });
    return finish(k, 0.09);
  }

  function stream(sr) {
    const k = kit(sr, 24, 606), secs = k.n / sr, busy = curve(k, Math.round(secs * 2.5), 0.15, 1), gurgle = curve(k, Math.round(secs * 6), 0.6, 1);
    for (let j = 0, m = secs * 480; j < m; j++) {
      const t = k.at();
      if (k.rand() > busy(t)) continue;
      const f = 300 * Math.pow(8, k.rand()), tau = 0.003 + 0.012 * Math.pow(500 / f, 0.7), [gl, gr] = gains(k.rnd(-1, 1));
      bubble(k, t, f, tau, k.rnd(0.15, 0.9), Math.pow(k.rand(), 2) * 0.25, gl, gr);
    }
    const ch = [0, 1].map(() => ({ off: k.at(), off2: k.at(), pink: pinkF(), band: svf(sr, 900, 0.5), hi: svf(sr, 4000, 0.7) }));
    render(k, 3, (i, o) => {
      const b = busy(i), g = gurgle(i);
      for (let c = 0; c < 2; c++) {
        const v = ch[c];
        v.band.run(v.pink(k.noise(i, v.off)));
        v.hi.run(k.noise(i, v.off2));
        o[c] += v.band.bp * (0.25 + 0.35 * b) * g + v.hi.hp * 0.03;
      }
    });
    return finish(k, 0.09);
  }

  // ---- fire ------------------------------------------------------------------

  function fire(sr) {
    const k = kit(sr, 40, 707), secs = k.n / sr, act = curve(k, Math.round(secs * 1.5), 0, 1), heat = curve(k, Math.round(secs / 3), 0.7, 1);
    // Fine ticks and crackle clusters, busier when the fire flares up.
    for (let j = 0, m = secs * 110; j < m; j++) {
      let t = k.at();
      const a = act(t);
      if (k.rand() > a * a * 0.9 + 0.1) continue;
      const [gl, gr] = gains(k.rnd(-0.8, 0.8)), base = 0.1 + 0.9 * Math.pow(k.rand(), 1.5);
      for (let c = 0, m2 = 1 + (k.rand() * 5 | 0); c < m2; c++) {
        crackle(k, t, k.rnd(0.0002, 0.0018), base * k.rnd(0.08, 0.25), gl, gr);
        t = wrap(k, t + Math.round(k.rnd(0.003, 0.04) * sr));
      }
    }
    // Pops: a woody snap, then a few sparks.
    for (let j = 0, m = Math.round(secs / 2.2); j < m; j++) {
      let t = k.at();
      const [gl, gr] = gains(k.rnd(-0.6, 0.6)), a = k.rnd(0.25, 0.6);
      burst(k, t, k.rnd(0.003, 0.008), a, 150, 3500, gl, gr);
      for (let s = 0, m2 = 2 + (k.rand() * 5 | 0); s < m2; s++) {
        t = wrap(k, t + Math.round(k.rnd(0.01, 0.12) * sr));
        crackle(k, t, k.rnd(0.0003, 0.001), a * k.rnd(0.2, 0.5), gl, gr);
      }
    }
    // Under it all, a low, steady burble of flame and a faint hiss.
    const ch = [0, 1].map(() => ({ off: k.at(), off2: k.at(), brown: brownF(), pink: pinkF(), low: svf(sr, 180, 0.6), hiss: svf(sr, 3500, 0.6) }));
    render(k, 3, (i, o) => {
      const h = heat(i);
      for (let c = 0; c < 2; c++) {
        const v = ch[c];
        v.low.run(v.brown(k.noise(i, v.off)));
        v.hiss.run(v.pink(k.noise(i, v.off2)));
        o[c] += v.low.lp * 0.025 * h + v.hiss.hp * 0.01 * h;
      }
    });
    return finish(k, 0.05);
  }

  // ---- birds -----------------------------------------------------------------

  // A dove's coo: a soft, hollow hum with some breath in it.
  function coo(k, t, dur, f0, f1, v, gl, gr) {
    const len = Math.round(dur * k.sr), [L, R] = k.ch, breath = svf(k.sr, f0 * 2, 1.5);
    let ph = 0;
    for (let j = 0; j < len; j++) {
      const x = j / len;
      ph += TAU * (f0 + (f1 - f0) * x) / k.sr;
      breath.run(k.rand() * 2 - 1);
      const s = (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph) + breath.bp * 0.25) * Math.pow(Math.sin(Math.PI * x), 0.6) * v * 0.4;
      const i = wrap(k, t + j); L[i] += s * gl; R[i] += s * gr;
    }
  }

  // Song shapes. Each writes one phrase at sample t around base pitch f.
  const songs = {
    warble(k, t, f, gl, gr) { // a run of slurred whistles (robin, blackbird)
      for (let j = 0, m = 3 + (k.rand() * 5 | 0); j < m; j++) {
        const d = k.rnd(0.08, 0.2), a = f * k.rnd(0.8, 1.3), b = a * k.rnd(0.75, 1.35), v = k.rnd(0.6, 1);
        tone(k, t, d, x => a + (b - a) * x, x => bell(x) * v, gl, gr, 0.06);
        t += Math.round((d + k.rnd(0.04, 0.12)) * k.sr);
      }
    },
    feebee(k, t, f, gl, gr) { // two clear whistles, high then low (chickadee)
      tone(k, t, 0.3, x => f * (1.12 - 0.03 * x), flat, gl, gr);
      tone(k, t + Math.round(0.36 * k.sr), 0.38, x => f * (0.92 - 0.04 * x), flat, gl, gr);
    },
    trill(k, t, f, gl, gr) { // fast repeated down-sweeps (sparrow, wren)
      const m = 10 + (k.rand() * 14 | 0), gap = k.rnd(0.05, 0.075);
      for (let j = 0; j < m; j++) {
        const v = 0.4 + 0.6 * Math.sin(Math.PI * (j + 0.5) / m);
        tone(k, t + Math.round(j * gap * k.sr), gap * 0.6, x => f * (1.35 - 0.5 * x), x => bell(x) * v, gl, gr, 0.1);
      }
    },
    chirp(k, t, f, gl, gr) { // short bright tweets
      for (let j = 0, m = 1 + (k.rand() * 4 | 0); j < m; j++) {
        const d = k.rnd(0.04, 0.08);
        tone(k, t, d, x => f * (1 + 0.5 * Math.sin(Math.PI * x)), pluck, gl, gr, 0.15);
        t += Math.round((d + k.rnd(0.06, 0.16)) * k.sr);
      }
    },
    cheer(k, t, f, gl, gr) { // ringing down-slurred whistles, "cheer cheer cheer" (cardinal)
      const m = 3 + (k.rand() * 4 | 0), d = k.rnd(0.16, 0.26), hi = f * 1.25, lo = f * 0.7;
      for (let j = 0; j < m; j++) {
        tone(k, t, d, x => hi + (lo - hi) * Math.sqrt(x), x => Math.pow(bell(x), 0.7), gl, gr, 0.05);
        t += Math.round((d + k.rnd(0.06, 0.12)) * k.sr);
      }
    },
    twitter(k, t, f, gl, gr) { // a long, quick jumble of notes (finch)
      const end = t + Math.round(k.rnd(1.2, 2.8) * k.sr);
      while (t < end) {
        const d = k.rnd(0.025, 0.07), a = f * k.rnd(0.75, 1.5), b = a * k.rnd(0.7, 1.4), v = k.rnd(0.4, 1);
        tone(k, t, d, x => a + (b - a) * x + a * 0.04 * Math.sin(TAU * 4 * x), x => bell(x) * v, gl, gr, 0.12);
        t += Math.round((d + k.rnd(0.008, 0.04)) * k.sr);
      }
    },
    dove(k, t, f, gl, gr) { // collared dove: coo-COOO-coo, a few times over
      for (let r = 0, m = 2 + (k.rand() * 3 | 0); r < m; r++) {
        let at = t;
        for (const [d, a, b, v, gap] of [[0.22, 1, 1, 0.55, 0.07], [0.48, 1.07, 1, 1, 0.13], [0.3, 0.93, 0.9, 0.7, 0]]) {
          coo(k, at, d, f * a, f * b, v, gl, gr);
          at += Math.round((d + gap) * k.sr);
        }
        t += Math.round(k.rnd(1.25, 1.45) * k.sr);
      }
    },
    drum(k, t, f, gl, gr) { // a woodpecker drumming on a hollow branch
      const m = 12 + (k.rand() * 14 | 0), rate = k.rnd(15, 22);
      for (let j = 0; j < m; j++) {
        const a = 0.6 + 0.4 * Math.sin(Math.PI * (j + 0.5) / m);
        ping(k, t, f * k.rnd(0.97, 1.03), 0.004, a * 0.6, gl, gr);
        burst(k, t, 0.0012, a * 0.5, 600, 4000, gl, gr);
        t += Math.round(k.sr / (rate * (1 + 0.15 * j / m)));
      }
    },
  };

  function birds(sr) {
    const k = kit(sr, 80, 505), secs = k.n / sr;
    // [song, base pitch, seconds between phrases, nearest it gets]
    const flock = [['warble', 2700, 6, 1], ['warble', 3300, 8, 1], ['feebee', 3700, 11, 0.8], ['trill', 5000, 9, 0.8],
                   ['chirp', 4300, 4, 1], ['chirp', 3500, 6, 0.7], ['cheer', 2800, 10, 0.9], ['twitter', 4200, 9, 0.7],
                   ['dove', 500, 17, 0.7], ['drum', 750, 24, 0.35]];
    for (const [song, f, every, nearest] of flock) {
      const near = k.rnd(0.25, 1) * nearest, mood = curve(k, 7, 0, 1), pitch = f * k.rnd(0.92, 1.08), [gl, gr] = gains(k.rnd(-0.8, 0.8));
      for (let s = k.rnd(0, every); s < secs; s += every * k.rnd(0.6, 1.5)) {
        const t = Math.round(s * sr);
        if (mood(t) >= 0.3) songs[song](k, t, pitch * k.rnd(0.97, 1.03), gl * near, gr * near);
      }
    }
    const rl = reverb(sr, 0, 0.78), rr = reverb(sr, 23, 0.78), leaves = curve(k, 24, 0.15, 1);
    const ch = [0, 1].map(() => ({ off: k.at(), pink: pinkF(), band: svf(sr, 2500, 0.5) }));
    render(k, 3, (i, o) => {
      const l = o[0], r = o[1], lv = leaves(i);
      for (let c = 0; c < 2; c++) ch[c].band.run(ch[c].pink(k.noise(i, ch[c].off)));
      o[0] = l + rl(l * 0.7 + r * 0.3) * 0.35 + ch[0].band.bp * 0.05 * lv;
      o[1] = r + rr(r * 0.7 + l * 0.3) * 0.35 + ch[1].band.bp * 0.05 * lv;
    });
    return finish(k, 0.055);
  }

  // ---- night -----------------------------------------------------------------

  function night(sr) {
    const k = kit(sr, 48, 808), { n } = k;
    // Crickets: soft, buzzy chirps (a quick train of tooth strikes rather than a clean
    // whistle), pitched low like tree crickets. A couple nearby, the rest far off.
    for (let c = 0; c < 7; c++) {
      const near = c < 2 ? k.rnd(0.15, 0.25) : k.rnd(0.03, 0.08), f = k.rnd(2300, 3300);
      const P = Math.round(n / Math.round(n / (k.rnd(0.45, 1.1) * sr))), pulses = 2 + (k.rand() * 3 | 0);
      const pw = k.rnd(0.02, 0.035), pg = Math.round((pw + k.rnd(0.012, 0.02)) * sr), teeth = 5 + (k.rand() * 4 | 0);
      const [gl, gr] = gains(k.rnd(-0.9, 0.9)), mood = curve(k, 6, 0, 1);
      const buzz = x => bell(x) * (0.55 + 0.45 * Math.sin(TAU * teeth * x));
      for (let t = k.at() % P; t < n; t += P) {
        if (mood(t) < 0.25) continue;
        for (let j = 0; j < pulses; j++) tone(k, t + j * pg, pw, x => f * (1 - 0.02 * x), buzz, gl * near, gr * near);
      }
    }
    // A distant owl, a couple of times per loop.
    for (const t of times(k, 24, 0.2)) {
      const f = k.rnd(360, 420);
      for (const [at, d] of [[0, 0.45], [0.75, 0.22], [1.05, 0.5]])
        tone(k, t + Math.round(at * k.sr), d, x => f * (1.02 - 0.06 * x), bell, 0.18, 0.12, 0.05);
    }
    const rl = reverb(sr, 0, 0.8), rr = reverb(sr, 23, 0.8), air = curve(k, 12, 0.5, 1);
    const ch = [0, 1].map(() => ({ off: k.at(), pink: pinkF(), lp: svf(sr, 500, 0.6) }));
    render(k, 3, (i, o) => {
      const l = o[0], r = o[1], a = air(i);
      for (let c = 0; c < 2; c++) ch[c].lp.run(ch[c].pink(k.noise(i, ch[c].off)));
      o[0] = l + rl(l + r * 0.3) * 0.3 + ch[0].lp.lp * 0.08 * a;
      o[1] = r + rr(r + l * 0.3) * 0.3 + ch[1].lp.lp * 0.08 * a;
    });
    return finish(k, 0.045);
  }

  function brown(sr) {
    const k = kit(sr, 20, 909), ch = [0, 1].map(() => ({ off: k.at(), b: brownF(), hp: svf(sr, 30, 0.7) }));
    render(k, 2, (i, o) => {
      for (let c = 0; c < 2; c++) { const v = ch[c]; v.hp.run(v.b(k.noise(i, v.off))); o[c] += v.hp.hp; }
    });
    return finish(k, 0.11);
  }

  const SOUNDS = { rain, car, storm, waves, wind, birds, stream, fire, night, brown };
  const render_ = (id, sr) => {
    if (!SOUNDS[id]) throw new Error('Unknown sound: ' + id);
    return SOUNDS[id](sr);
  };
  global.AmbienceSynth = { render: render_, ids: Object.keys(SOUNDS) };

  if (typeof WorkerGlobalScope !== 'undefined' && global instanceof WorkerGlobalScope) {
    global.onmessage = e => {
      const { job, id, sr } = e.data;
      try {
        const ch = render_(id, sr);
        global.postMessage({ job, ch }, ch.map(a => a.buffer));
      } catch (err) {
        global.postMessage({ job, error: String(err && err.message || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
