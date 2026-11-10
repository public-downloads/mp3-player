/* Folder Player colour themes. Loaded in <head>, before anything draws, so the saved theme is on
 * from the first frame. A theme names the few colours index.html's styles are built from; the
 * in-between shades (strong borders, tints, see-through bars) are worked out from those. */
'use strict';
window.Themes = (() => {
  // ink: background · panel: rows and buttons · press: pressed · line: borders
  // text, dim: main and quiet text · live: the accent · hot: warnings and Delete
  const list = [
    { id: 'paper',   name: 'Paper',    group: 'Light',  ink: '#fbfbfc', panel: '#f0f1f4', press: '#e4e6eb', line: '#dfe2e8', text: '#1b1e24', dim: '#5e6573', live: '#2452d4', hot: '#c0392b' },
    { id: 'linen',   name: 'Linen',    group: 'Light',  ink: '#f7f1e5', panel: '#efe6d5', press: '#e5d9c3', line: '#e2d6bf', text: '#2c241a', dim: '#6a5d4c', live: '#a1431a', hot: '#b3261e' },
    { id: 'frost',   name: 'Frost',    group: 'Light',  ink: '#f2f6f9', panel: '#e6edf3', press: '#d9e3ec', line: '#d3dee8', text: '#14212c', dim: '#536575', live: '#0d677d', hot: '#b5412c' },
    { id: 'blossom', name: 'Blossom',  group: 'Light',  ink: '#fcf4f6', panel: '#f6e8ec', press: '#eedbe1', line: '#ead5dc', text: '#2b1a21', dim: '#715862', live: '#ab2157', hot: '#bd3628' },
    { id: 'meadow',  name: 'Meadow',   group: 'Light',  ink: '#f3f6ec', panel: '#e8eedd', press: '#dce5cf', line: '#d6e0c8', text: '#1c2618', dim: '#57654f', live: '#2c6626', hot: '#b2412a' },

    { id: 'slate',   name: 'Slate',    group: 'Medium', ink: '#2a3240', panel: '#333c4c', press: '#3c4658', line: '#465164', text: '#eef1f6', dim: '#a9b3c3', live: '#8dbdf7', hot: '#f4a08c' },
    { id: 'dusk',    name: 'Dusk',     group: 'Medium', ink: '#2f2941', panel: '#39324c', press: '#433b58', line: '#4e4566', text: '#f2eef9', dim: '#b8adcc', live: '#cba6f7', hot: '#f7a08f' },
    { id: 'moss',    name: 'Moss',     group: 'Medium', ink: '#2a3428', panel: '#333f31', press: '#3c4a3a', line: '#475644', text: '#eef3ea', dim: '#abbaa5', live: '#c0e37b', hot: '#f4a487' },
    { id: 'clay',    name: 'Clay',     group: 'Medium', ink: '#3a2c27', panel: '#45352f', press: '#503f38', line: '#5c4941', text: '#f8f0eb', dim: '#cbb5aa', live: '#f7ad7d', hot: '#ff9a9a' },
    { id: 'harbor',  name: 'Harbor',   group: 'Medium', ink: '#213937', panel: '#284341', press: '#304e4b', line: '#3a5a57', text: '#eaf5f3', dim: '#a3c1bc', live: '#70e6d6', hot: '#f7a38d' },

    { id: 'mint',    name: 'Mint',     group: 'Dark',   ink: '#12161c', panel: '#1a2029', press: '#222b36', line: '#2a3341', text: '#e6e9ee', dim: '#8d99aa', live: '#6fd3b8', hot: '#e0876f',
      line2: '#3a4658', livebg: '#1c3530', okline: '#2f5a50', warnbg: '#2a1f1c', warnline: '#4a332c', raise: '#28313d' },
    { id: 'studio',  name: 'Studio',   group: 'Dark',   ink: '#16191f', panel: '#1e222a', press: '#262b35', line: '#2f3541', text: '#e8ebf0', dim: '#8f99a9', live: '#5ca9f2', hot: '#ee8b77' },
    { id: 'ember',   name: 'Ember',    group: 'Dark',   ink: '#1a1411', panel: '#241c18', press: '#2e241f', line: '#392d27', text: '#f4ece6', dim: '#ab998c', live: '#f59c4d', hot: '#f27b6b' },
    { id: 'deepsea', name: 'Deep Sea', group: 'Dark',   ink: '#0b1626', panel: '#112034', press: '#172941', line: '#1f3351', text: '#e3edf7', dim: '#869cb6', live: '#40c7ef', hot: '#f28c7c' },
    { id: 'forest',  name: 'Forest',   group: 'Dark',   ink: '#111a13', panel: '#18241b', press: '#1f2e23', line: '#29392c', text: '#e6f0e6', dim: '#91a594', live: '#8dda6c', hot: '#ee8c72' },
    { id: 'plum',    name: 'Plum',     group: 'Dark',   ink: '#1b1422', panel: '#251c2e', press: '#2e2339', line: '#392c46', text: '#f2eaf6', dim: '#a896b5', live: '#f381c4', hot: '#f6927c' },
    { id: 'carbon',  name: 'Carbon',   group: 'Dark',   ink: '#0e0e0f', panel: '#18181a', press: '#212123', line: '#2b2b2e', text: '#ededef', dim: '#95959b', live: '#f5c23e', hot: '#f2826e' },
  ];
  const groups = ['Light', 'Medium', 'Dark'];
  const fallback = 'mint';  // the original look

  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  // a with t of b mixed in
  const mix = (a, b, t) => '#' + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

  // Every colour index.html uses, for one theme.
  function colours(t) {
    const light = t.group === 'Light';
    return {
      ink: t.ink, panel: t.panel, press: t.press, line: t.line, text: t.text, dim: t.dim, live: t.live, hot: t.hot,
      line2: t.line2 || mix(t.line, t.text, light ? .16 : .14),     // a border that stands out (the open tab, toasts)
      livebg: t.livebg || mix(t.ink, t.live, light ? .12 : .16),    // behind something that's on
      okline: t.okline || mix(t.ink, t.live, .38),
      warnbg: t.warnbg || mix(t.ink, t.hot, light ? .07 : .1),
      warnline: t.warnline || mix(t.ink, t.hot, .3),
      raise: t.raise || mix(t.ink, t.text, light ? .07 : .1),       // toasts
      'ink-rgb': rgb(t.ink).join(','),                               // for see-through bars over covers
      scrim: light ? 'rgba(0,0,0,.32)' : 'rgba(0,0,0,.55)',
      shadow: light ? '0 6px 24px rgba(0,0,0,.14)' : '0 6px 24px rgba(0,0,0,.35)',
    };
  }

  let current = fallback;
  function apply(id) {
    const t = list.find(x => x.id === id) || list.find(x => x.id === fallback);
    const root = document.documentElement, c = colours(t);
    for (const k in c) root.style.setProperty('--' + k, c[k]);
    root.style.colorScheme = t.group === 'Light' ? 'light' : 'dark';  // scrollbars, sliders, text boxes
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.ink);
    // On a home-screen iPhone app, white status-bar text would vanish on a light theme.
    // iOS may only pick this up the next time the app opens.
    document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')
      ?.setAttribute('content', t.group === 'Light' ? 'default' : 'black-translucent');
    current = t.id;
  }
  function set(id) {
    apply(id);
    try { localStorage.setItem('fp.theme', JSON.stringify(current)); } catch {}
  }

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('fp.theme')); } catch {}
  apply(saved);

  return { list, groups, set, current: () => current };
})();
