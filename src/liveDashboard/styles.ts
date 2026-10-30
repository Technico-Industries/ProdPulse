// src/liveDashboard/styles.ts
//
// CSS of the web Live Dashboard (injected by LiveDashboardView). Dark,
// TV-first control-room look, designed at 1920×1080: the root font-size is
// 16px there and scales with the tighter of width/height.
// Series colours were checked with the dataviz palette validator against the
// panel surface (all pairs, normal + colour-blind vision): production
// #3987e5, rejections #d95926, loss #199e70. Status colours (live / stopped /
// efficiency bands) are separate and always shown with a text label.

export const LIVE_DASHBOARD_CSS = `
.ld {
  --bg: #0b0f13; --surface: #141a20; --surface-2: #1b232b; --border: #26303a; --border-strong: #354250;
  --text: #eef1f4; --text-2: #b4bdc6; --muted: #7f8b96;
  --good: #3987e5; --plan: #c3c2b7; --reject: #d95926; --loss: #199e70;
  --ok: #0ca30c; --ok-text: #3cc63c; --warn: #fab219; --crit: #d03b3b; --crit-text: #f07272;
  position: fixed; inset: 0; z-index: 10; box-sizing: border-box;
  font-size: min(0.8333vw, 1.4815vh);
  display: flex; flex-direction: column; gap: 0.9em;
  padding: 1em 1.25em 1.25em; overflow: hidden;
  background:
    radial-gradient(60em 30em at 15% -10%, rgba(57,135,229,0.16), transparent 70%),
    radial-gradient(50em 30em at 100% 0%, rgba(25,158,112,0.08), transparent 70%),
    var(--bg);
  color: var(--text); font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
}
.ld *, .ld *::before, .ld *::after { box-sizing: border-box; }
.ld h1, .ld h2, .ld p, .ld ol { margin: 0; }

/* ── Header ── */
.ld-header { display: flex; align-items: center; justify-content: space-between; gap: 1.5em; animation: ld-fade 0.6s ease both; }
.ld-brand { display: flex; align-items: center; gap: 0.8em; }
.ld-brand__logo { display: grid; place-items: center; width: 2.6em; height: 2.6em; font-size: 1.15em; border-radius: 0.6em; color: #fff;
  background: linear-gradient(135deg, #3987e5, #1c5fb0); box-shadow: 0 0 1.2em rgba(57,135,229,0.45); }
.ld-brand__name { font-size: 1.75em; font-weight: 800; letter-spacing: 0.01em; }
.ld-brand__name span { color: var(--text-2); font-weight: 600; margin-left: 0.25em; }
.ld-brand__scope { color: var(--muted); font-size: 1.05em; margin-top: 0.1em; }
.ld-header__right { display: flex; align-items: center; gap: 1.1em; }
.ld-updated { color: var(--muted); font-size: 1em; }
.ld-live { display: inline-flex; align-items: center; gap: 0.5em; font-weight: 800; letter-spacing: 0.12em; font-size: 0.95em;
  padding: 0.38em 0.9em; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-2); }
.ld-live i { position: relative; width: 0.7em; height: 0.7em; border-radius: 50%; background: var(--muted); }
.ld-live--on { color: var(--ok-text); border-color: rgba(12,163,12,0.7); background: rgba(12,163,12,0.08); }
.ld-live--on i { background: var(--ok); }
.ld-live--on i::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--ok); animation: ld-ping 1.8s ease-out infinite; }
.ld-live--off { color: var(--crit-text); border-color: var(--crit); background: rgba(208,59,59,0.1); }
.ld-live--off i { background: var(--crit); animation: ld-blink 1s steps(2) infinite; }
.ld-clock { font-size: 2.2em; font-weight: 700; min-width: 5.2em; text-align: right; letter-spacing: 0.02em; }
.ld-iconbtn { display: inline-grid; place-items: center; width: 2.4em; height: 2.4em; font-size: 1.1em; cursor: pointer;
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong); border-radius: 0.5em; transition: border-color 0.2s, background 0.2s; }
.ld-iconbtn:hover { border-color: var(--good); background: #1f2a35; }

/* ── Banners ── */
.ld-banners { display: grid; gap: 0.4em; }
.ld-banners:empty { display: none; }
.ld-banner { display: flex; align-items: center; gap: 0.7em; padding: 0.5em 0.9em; border-radius: 0.5em; font-size: 1.05em; font-weight: 600; border: 1px solid;
  animation: ld-slide 0.4s ease both; }
.ld-banner b { display: inline-grid; place-items: center; width: 1.4em; height: 1.4em; border-radius: 50%; color: #111; flex: none; }
.ld-banner--critical { border-color: var(--crit); color: var(--crit-text); background: rgba(208,59,59,0.12); }
.ld-banner--critical b { background: var(--crit); color: #fff; }
.ld-banner--warning { border-color: var(--warn); color: var(--warn); background: rgba(250,178,25,0.1); }
.ld-banner--warning b { background: var(--warn); }
.ld-banner--info { border-color: var(--border-strong); color: var(--text-2); background: var(--surface); }
.ld-banner--info b { background: var(--text-2); }

/* ── KPI tiles ── */
.ld-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.9em; }
.ld-kpi { position: relative; overflow: hidden; min-width: 0; height: 10.6em;
  background: linear-gradient(180deg, rgba(255,255,255,0.025), transparent 40%), var(--surface);
  border: 1px solid var(--border); border-radius: 0.8em; padding: 0.85em 1.1em 0;
  display: flex; flex-direction: column; gap: 0.2em;
  animation: ld-rise 0.6s cubic-bezier(.2,.8,.2,1) both; transition: border-color 0.4s, box-shadow 0.4s; }
.ld-kpi:nth-child(2) { animation-delay: 0.05s; } .ld-kpi:nth-child(3) { animation-delay: 0.1s; }
.ld-kpi:nth-child(4) { animation-delay: 0.15s; } .ld-kpi:nth-child(5) { animation-delay: 0.2s; } .ld-kpi:nth-child(6) { animation-delay: 0.25s; }
.ld-kpi::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 0.25em; background: var(--good); opacity: 0.9; }
.ld-kpi--reject::before { background: var(--reject); }
.ld-kpi--loss::before { background: var(--loss); }
.ld-kpi.is-updated { border-color: rgba(57,135,229,0.8); box-shadow: 0 0 0 1px rgba(57,135,229,0.5), 0 0 1.6em rgba(57,135,229,0.35); }
.ld-kpi--alert { border-color: var(--crit); box-shadow: 0 0 1.4em rgba(208,59,59,0.25); }
.ld-kpi__label { font-size: 0.9em; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.08em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; position: relative; z-index: 1; }
.ld-kpi__value { font-size: 2.75em; font-weight: 800; line-height: 1.05; white-space: nowrap; position: relative; z-index: 1; letter-spacing: -0.01em; }
.ld-kpi__value small { font-size: 0.4em; font-weight: 600; color: var(--muted); margin-left: 0.35em; letter-spacing: 0.04em; }
.ld-kpi__sub { font-size: 0.95em; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; position: relative; z-index: 1; }
.ld-kpi__sub b { color: var(--text-2); font-weight: 700; }
.ld-spark { position: absolute; left: 0; right: 0; bottom: 0; height: 3.4em; opacity: 0.9; pointer-events: none; }
.ld-running { display: inline-flex; align-items: center; gap: 0.45em; color: var(--crit-text); font-weight: 700; }
.ld-running i { width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--crit); animation: ld-blink 1s steps(2) infinite; }

/* ── Gauge ── */
.ld-gauge { position: relative; flex: 1; min-height: 0; display: flex; align-items: flex-end; justify-content: center; margin-top: -0.2em; }
.ld-gauge svg { height: 100%; max-height: 6.2em; width: auto; overflow: visible; }
.ld-gauge__track { fill: none; stroke: var(--surface-2); stroke-width: 14; stroke-linecap: round; }
.ld-gauge__value { fill: none; stroke-width: 14; stroke-linecap: round; transition: stroke 0.6s; }
.ld-gauge__tick { stroke: var(--bg); stroke-width: 2.5; }
.ld-gauge__num { fill: var(--text); font-size: 30px; font-weight: 800; }
.ld-band { position: absolute; right: 0; top: 0.1em; font-size: 0.8em; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0.15em 0.6em; border: 1px solid; border-radius: 999px; background: rgba(0,0,0,0.25); }

/* ── Panels ── */
.ld-grid { flex: 1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-template-rows: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 0.9em; min-height: 0; }
.ld-span2 { grid-column: span 2; }
.ld-panel { position: relative; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 0.4em;
  background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent 30%), var(--surface);
  border: 1px solid var(--border); border-radius: 0.8em; padding: 0.85em 1em;
  animation: ld-rise 0.7s cubic-bezier(.2,.8,.2,1) both; }
.ld-grid > :nth-child(2) { animation-delay: 0.1s; } .ld-grid > :nth-child(3) { animation-delay: 0.18s; }
.ld-grid > :nth-child(4) { animation-delay: 0.26s; } .ld-grid > :nth-child(5) { animation-delay: 0.34s; }
.ld-panel__head { display: flex; align-items: baseline; justify-content: space-between; gap: 1em; }
.ld-panel__title { font-size: 1.3em; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-panel__meta { color: var(--muted); font-size: 1em; white-space: nowrap; }
.ld-panel__meta b { color: var(--text); }
.ld-legend { display: inline-flex; gap: 1.4em; color: var(--text-2); font-size: 1.05em; white-space: nowrap; }
.ld-legend span { display: inline-flex; align-items: center; gap: 0.5em; }
.ld-sw { display: inline-block; width: 1.6em; height: 0; border-top: 3px solid; }
.ld-sw--good { border-color: var(--good); box-shadow: 0 0 0.5em rgba(57,135,229,0.8); }
.ld-sw--plan { border-color: var(--plan); border-top-style: dashed; }
.ld-sw--today { width: 0.9em; height: 0.9em; border: 2.5px solid var(--good); border-radius: 50%; }

/* ── Charts ── */
.ld-chart { flex: 1; min-height: 0; position: relative; }
.ld-chart svg { position: absolute; inset: 0; overflow: visible; font-size: 1em; }
.ld-gridline { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 6; }
.ld-baseline { stroke: var(--border-strong); stroke-width: 1.5; }
.ld-tick, .ld-unit { fill: var(--muted); font-size: 0.85em; }
.ld-xlabel { fill: var(--text-2); font-size: 0.95em; font-weight: 600; transition: fill 0.2s; }
.ld-xlabel.is-today { fill: var(--text); font-weight: 800; }
.ld-rowlabel { fill: var(--muted); font-size: 0.85em; font-weight: 600; }
.ld-rowvalue { fill: var(--text-2); font-size: 0.95em; font-weight: 600; transition: fill 0.2s; }
.ld-rowvalue.is-today { fill: var(--text); font-weight: 800; }
.ld-xlabel.is-hover, .ld-rowvalue.is-hover { fill: #fff; }
.ld-compact .ld-xlabel, .ld-compact .ld-rowvalue { font-size: 0.82em; }
.ld-hit { fill: transparent; cursor: crosshair; }
.ld-crosshair { stroke: rgba(255,255,255,0.35); stroke-width: 1; stroke-dasharray: 3 4; pointer-events: none; }
.ld-line { fill: none; stroke-linejoin: round; stroke-linecap: round; }
.ld-line--good { stroke: var(--good); stroke-width: 3; }
.ld-line--plan { stroke: var(--plan); stroke-dasharray: 7 7; stroke-width: 2; opacity: 0.85; animation: ld-dash 1.4s linear infinite; }
.ld-dot { fill: var(--good); stroke: var(--surface); stroke-width: 2.5; transition: r 0.2s; }
.ld-dot--today { fill: var(--surface); stroke: var(--good); stroke-width: 3.5; }
.ld-pulse { fill: var(--good); opacity: 0.5; transform-box: fill-box; transform-origin: center; animation: ld-ring 2s ease-out infinite; }
.ld-direct { fill: var(--text); font-size: 1.05em; font-weight: 800; paint-order: stroke; stroke: var(--surface); stroke-width: 5px; stroke-linejoin: round; }
.ld-bar { transition: filter 0.2s, opacity 0.2s; }
.ld-bar.is-hover { filter: brightness(1.25); }
.ld-bar--today { animation: ld-breathe 2.4s ease-in-out infinite; }

.ld-tip { position: absolute; z-index: 5; pointer-events: none; min-width: 13em; padding: 0.6em 0.8em; border-radius: 0.6em;
  background: rgba(14,19,24,0.94); border: 1px solid var(--border-strong); box-shadow: 0 0.6em 1.8em rgba(0,0,0,0.45);
  backdrop-filter: blur(6px); animation: ld-fade 0.15s ease both; }
.ld-tip__title { font-weight: 800; margin-bottom: 0.35em; }
.ld-tip__row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.55em; color: var(--text-2); font-size: 0.95em; line-height: 1.6; }
.ld-tip__row i { width: 0.7em; height: 0.7em; border-radius: 0.15em; }
.ld-tip__row span { grid-column: 2; }
.ld-tip__row b { color: var(--text); text-align: right; }

/* ── Downtime reasons ── */
.ld-reasons { list-style: none; padding: 0; display: grid; gap: 0.7em; align-content: space-evenly; flex: 1; margin-top: 0.3em; }
.ld-reasons li { display: grid; grid-template-columns: 1.6em 10em minmax(0, 1fr) 4.6em 3em; align-items: center; gap: 0.6em; font-size: 1.05em;
  animation: ld-slide 0.5s ease both; }
.ld-reasons li:nth-child(2) { animation-delay: 0.06s; } .ld-reasons li:nth-child(3) { animation-delay: 0.12s; }
.ld-reasons li:nth-child(4) { animation-delay: 0.18s; } .ld-reasons li:nth-child(5) { animation-delay: 0.24s; } .ld-reasons li:nth-child(6) { animation-delay: 0.3s; }
.ld-reasons__rank { display: grid; place-items: center; width: 1.5em; height: 1.5em; border-radius: 0.35em; font-size: 0.85em; font-weight: 800;
  background: var(--surface-2); color: var(--text-2); }
.ld-reasons li:first-child .ld-reasons__rank { background: var(--loss); color: #fff; }
.ld-reasons__label { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-reasons__track { height: 1.05em; background: var(--surface-2); border-radius: 0.3em; overflow: hidden; }
.ld-reasons__fill { display: block; height: 100%; border-radius: 0.3em;
  background: linear-gradient(90deg, rgba(25,158,112,0.55), var(--loss)); box-shadow: 0 0 0.8em rgba(25,158,112,0.35); }
.ld-reasons__value { text-align: right; font-weight: 800; }
.ld-reasons__share { text-align: right; color: var(--muted); font-size: 0.9em; }
.ld-reasons__more { color: var(--muted); font-size: 0.95em !important; display: block !important; padding-left: 2.2em; }

.ld-empty { flex: 1; display: grid; place-items: center; color: var(--muted); font-size: 1.1em; text-align: center; }
.ld-empty--good { color: var(--ok-text); }

/* ── States ── */
.ld-state { margin: auto; width: min(60em, 100%); text-align: center; display: grid; justify-items: center; gap: 1em;
  background: var(--surface); border: 1px solid var(--border); border-radius: 1em; padding: 3em 2.5em; animation: ld-rise 0.5s ease both; }
.ld-state--critical { border-color: var(--crit); }
.ld-state__mark { width: 1.4em; height: 1.4em; border-radius: 50%; background: var(--crit); }
.ld-state__title { font-size: 2.2em; }
.ld-state__body { color: var(--text-2); font-size: 1.3em; max-width: 46em; }
.ld-spinner { width: 3.5em; height: 3.5em; border-radius: 50%; border: 0.35em solid var(--border-strong); border-top-color: var(--good);
  animation: ld-spin 0.9s linear infinite; }

/* ── Panel extras ── */
.ld-grid > :nth-child(6) { animation-delay: 0.42s; } .ld-grid > :nth-child(7) { animation-delay: 0.5s; }
.ld-panel__sub { color: var(--muted); font-size: 1em; margin-top: -0.2em; }
.ld-panel__sub b { color: var(--text); }
.ld-accent { color: var(--good) !important; }
.ld-crit { color: var(--crit-text) !important; }
.ld-ok { color: var(--ok-text) !important; }
.ld-panel--alert { border-color: rgba(208,59,59,0.7); box-shadow: inset 0 0 0 1px rgba(208,59,59,0.25), 0 0 1.4em rgba(208,59,59,0.18); }
.ld-legend--sm { font-size: 0.95em; gap: 1em; }
.ld-sw--box { width: 0.85em; height: 0.85em; border: 0; border-radius: 0.2em; }
.ld-sw--planbox { background: var(--plan); opacity: 0.45; }
.ld-sw--goodbox { background: var(--good); }
.ld-bar--plan { fill: var(--plan); fill-opacity: 0.32; }
.is-hover .ld-bar { filter: brightness(1.25); }
.ld-future { fill: var(--border-strong); font-size: 1.1em; }
.ld-note { color: var(--muted); font-size: 0.85em; text-align: right; }

/* Stopped lines */
.ld-stopped { list-style: none; margin: 0.2em 0 0; padding: 0; display: grid; gap: 0.55em; align-content: start; flex: 1; min-height: 0; overflow: hidden; }
.ld-stopped li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.7em;
  padding: 0.55em 0.75em; border-radius: 0.6em; border: 1px solid rgba(208,59,59,0.45);
  background: linear-gradient(90deg, rgba(208,59,59,0.18), rgba(208,59,59,0.04)); animation: ld-slide 0.4s ease both; }
.ld-stopped__dot { width: 0.8em; height: 0.8em; border-radius: 50%; background: var(--crit); box-shadow: 0 0 0.8em var(--crit); animation: ld-blink 1.2s steps(2) infinite; }
.ld-stopped__main { display: flex; flex-direction: column; min-width: 0; }
.ld-stopped__main b { font-size: 1.15em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-stopped__main span { color: var(--crit-text); font-size: 0.92em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-stopped__timer { font-size: 1.45em; font-weight: 800; color: #fff; letter-spacing: 0.02em; }
.ld-allrun { flex: 1; display: grid; place-items: center; align-content: center; gap: 0.4em; text-align: center; }
.ld-allrun__icon { display: grid; place-items: center; width: 3em; height: 3em; border-radius: 50%; font-size: 1.4em; font-weight: 900;
  color: var(--ok-text); border: 2px solid var(--ok); box-shadow: 0 0 1.4em rgba(12,163,12,0.35); animation: ld-rise 0.5s ease both; }
.ld-allrun__title { font-size: 1.35em; font-weight: 800; color: var(--ok-text); }
.ld-allrun__sub { color: var(--muted); }

/* Types of rejection */
.ld-stages { display: flex; flex-wrap: wrap; gap: 0.4em 0.9em; color: var(--muted); font-size: 0.92em; }
.ld-stages b { color: var(--text-2); font-weight: 700; }
.ld-types { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5em; align-content: space-evenly; flex: 1; min-height: 0; }
.ld-types li { display: grid; grid-template-columns: minmax(0, 9.5em) minmax(0, 1fr) 3em 2.6em; align-items: center; gap: 0.55em; font-size: 0.98em;
  animation: ld-slide 0.45s ease both; }
.ld-types li:nth-child(2) { animation-delay: 0.05s; } .ld-types li:nth-child(3) { animation-delay: 0.1s; } .ld-types li:nth-child(4) { animation-delay: 0.15s; }
.ld-types li:nth-child(5) { animation-delay: 0.2s; } .ld-types li:nth-child(6) { animation-delay: 0.25s; } .ld-types li:nth-child(7) { animation-delay: 0.3s; }
.ld-types__label { display: flex; flex-direction: column; min-width: 0; color: var(--text-2); line-height: 1.15; }
.ld-types__label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-types__label em { font-style: normal; font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.ld-types__track { height: 0.95em; background: var(--surface-2); border-radius: 0.3em; overflow: hidden; }
.ld-types__fill { display: block; height: 100%; border-radius: 0.3em; background: linear-gradient(90deg, rgba(217,89,38,0.55), var(--reject));
  box-shadow: 0 0 0.8em rgba(217,89,38,0.3); }
.ld-types__value { text-align: right; font-weight: 800; }
.ld-types__share { text-align: right; color: var(--muted); font-size: 0.88em; }

/* Rotating panel */
.ld-dots { display: inline-flex; gap: 0.4em; }
.ld-dots button { width: 0.6em; height: 0.6em; padding: 0; border-radius: 50%; border: 0; background: var(--border-strong); cursor: pointer; transition: background 0.3s, transform 0.3s; }
.ld-dots button.is-on { background: var(--loss); transform: scale(1.25); }
.ld-rotate { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: ld-fade 0.6s ease both; }
.ld-progress { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; transform-origin: left; background: var(--loss); opacity: 0.6;
  border-radius: 0 0 0.8em 0.8em; animation-name: ld-progress; animation-timing-function: linear; animation-fill-mode: both; }
@keyframes ld-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.ld-grid .ld-reasons li { grid-template-columns: 1.5em minmax(0, 8.5em) minmax(0, 1fr) 4.4em 2.6em; font-size: 0.98em; }

/* ── Pages (swipe) ── */
.ld-tabs { display: inline-flex; padding: 0.25em; gap: 0.25em; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); }
.ld-tabs button { font: inherit; font-size: 1em; font-weight: 700; color: var(--text-2); background: transparent; border: 0; cursor: pointer;
  padding: 0.4em 1.1em; border-radius: 999px; transition: background 0.3s, color 0.3s; }
.ld-tabs button:hover { color: var(--text); }
.ld-tabs button.is-on { background: var(--good); color: #fff; box-shadow: 0 0 1em rgba(57,135,229,0.45); }
.ld-pager { position: relative; flex: 1; min-height: 0; overflow: hidden; touch-action: pan-y; }
.ld-pager.is-dragging { cursor: grabbing; user-select: none; }
.ld-track { display: flex; height: 100%; transition: transform 0.55s cubic-bezier(.22,.9,.25,1); will-change: transform; }
.ld-pager.is-dragging .ld-track { transition: none; }
.ld-page { flex: 0 0 100%; min-width: 0; height: 100%; display: flex; flex-direction: column; gap: 0.9em; padding-bottom: 0.9em; }
.ld-pagedots { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); display: flex; gap: 0.45em; pointer-events: none; }
.ld-pagedots i { width: 0.5em; height: 0.5em; border-radius: 999px; background: var(--border-strong); transition: width 0.3s, background 0.3s; }
.ld-pagedots i.is-on { width: 1.6em; background: var(--good); }

/* ── Running lines page ── */
.ll { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 0.8em; }
.ll-summary { display: flex; align-items: center; gap: 1.4em; flex-wrap: wrap; animation: ld-fade 0.5s ease both; }
.ll-summary__title { font-size: 1.5em; font-weight: 800; }
.ll-summary__title span { color: var(--muted); font-weight: 600; font-size: 0.7em; margin-left: 0.4em; }
.ll-summary__chips { display: flex; gap: 0.6em; }
.ll-chip { display: inline-flex; align-items: center; gap: 0.45em; padding: 0.3em 0.9em; border-radius: 999px; font-weight: 600; color: var(--text-2);
  border: 1px solid color-mix(in srgb, var(--st) 60%, transparent); background: color-mix(in srgb, var(--st) 12%, transparent);
  transition: box-shadow 0.4s, transform 0.4s; }
.ll-chip.is-updated { box-shadow: 0 0 1.2em color-mix(in srgb, var(--st) 60%, transparent); transform: scale(1.06); }
.ll-chip i { width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--st); box-shadow: 0 0 0.6em var(--st); }
.ll-chip b { color: var(--text); font-size: 1.15em; }
.ll-legend { margin-left: auto; display: flex; gap: 1.2em; color: var(--muted); font-size: 0.92em; align-items: center; }
.ll-legend span { display: inline-flex; align-items: center; gap: 0.45em; }

.ll-grid { flex: 1; min-height: 0; display: grid; gap: 0.8em; }
.ll-card { position: relative; min-height: 0; min-width: 0; overflow: hidden; display: flex; flex-direction: column; gap: 0.45em;
  padding: 0.85em 1em 0.75em; border-radius: 0.9em; border: 1px solid var(--border);
  background:
    radial-gradient(28em 10em at 0% 0%, color-mix(in srgb, var(--st) 14%, transparent), transparent 70%),
    linear-gradient(180deg, rgba(255,255,255,0.02), transparent 40%), var(--surface);
  animation: ll-in 0.6s cubic-bezier(.2,.8,.2,1) both; transition: border-color 0.4s, box-shadow 0.4s; }
.ll-card__accent { position: absolute; left: 0; top: 0; right: 0; height: 0.28em; background: var(--st); }
.ll-card--running .ll-card__accent {
  background: linear-gradient(90deg, transparent, var(--st), color-mix(in srgb, var(--st) 40%, #fff), var(--st), transparent);
  background-size: 200% 100%; animation: ll-flow 2.8s linear infinite; }
.ll-card--stopped { border-color: color-mix(in srgb, var(--st) 70%, transparent); animation: ll-in 0.6s cubic-bezier(.2,.8,.2,1) both, ll-alarm 1.8s ease-in-out 0.6s infinite; }
.ll-card.is-updated { border-color: rgba(57,135,229,0.85); box-shadow: 0 0 1.8em rgba(57,135,229,0.4); }
.ll-card--dense { font-size: 0.86em; }
.ll-card__head { display: flex; align-items: center; justify-content: space-between; gap: 0.6em; }
.ll-card__name { font-size: 1.4em; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ll-status { display: inline-flex; align-items: center; gap: 0.4em; flex: none; font-size: 0.82em; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--st); padding: 0.22em 0.65em; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--st) 60%, transparent); background: color-mix(in srgb, var(--st) 12%, transparent); }
.ll-status i { position: relative; width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--st); }
.ll-status i::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--st); animation: ld-ping 1.8s ease-out infinite; }
.ll-card--stopped .ll-status i::after { animation-duration: 0.9s; }
.ll-card__meta { color: var(--muted); font-size: 0.95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -0.2em; }

.ll-card__body { display: flex; align-items: center; gap: 0.9em; }
.ll-ring { position: relative; flex: none; width: 4.6em; height: 4.6em; }
.ll-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ll-ring__track { fill: none; stroke: var(--surface-2); stroke-width: 6; }
.ll-ring__value { fill: none; stroke-width: 6; stroke-linecap: round; transition: stroke 0.6s; }
.ll-ring__num { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 800; font-size: 0.95em; }
.ll-card__figures { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.35em; }
.ll-card__actual { display: flex; align-items: baseline; gap: 0.45em; min-width: 0; white-space: nowrap; }
.ll-big { font-size: 2.4em; font-weight: 800; line-height: 1; letter-spacing: -0.01em; }
.ll-of { color: var(--muted); font-size: 0.95em; }
.ll-var { margin-left: auto; font-weight: 800; font-size: 0.95em; }
.ll-up { color: var(--ok-text); }
.ll-down { color: var(--crit-text); }
.ll-shift { display: flex; align-items: center; gap: 0.6em; color: var(--muted); font-size: 0.85em; white-space: nowrap; }
.ll-shift__track { flex: 1; height: 0.4em; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.ll-shift__fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1c5fb0, var(--good)); box-shadow: 0 0 0.6em rgba(57,135,229,0.5); }

/* Hourly dots */
.ll-hours { position: relative; flex: 1; min-height: 3.4em; display: flex; flex-direction: column; justify-content: center; padding: 0 0.2em; }
.ll-hours--empty { color: var(--muted); font-size: 0.9em; align-items: center; }
.ll-hours__track { position: absolute; left: calc(100% / var(--n) / 2); right: calc(100% / var(--n) / 2); top: calc(50% - 0.9em);
  height: 0.22em; border-radius: 999px; background: var(--border); }
.ll-hours__fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2f8a52, #3cc63c); box-shadow: 0 0 0.6em rgba(60,198,60,0.55); }
.ll-hours__dots { position: relative; list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); }
.ll-hours__dots li { display: flex; flex-direction: column; align-items: center; gap: 0.35em; min-width: 0; }
.ll-dot { position: relative; display: grid; place-items: center; width: 1.85em; height: 1.85em; border-radius: 50%; flex: none;
  border: 2px solid var(--border-strong); background: var(--bg); }
.ll-dot--completed { background: radial-gradient(circle at 35% 30%, #6fe36f, #22a83a 70%); border-color: #3cc63c;
  box-shadow: 0 0 0.7em rgba(60,198,60,0.6); animation: ll-pop 0.55s cubic-bezier(.3,1.6,.5,1) both; }
.ll-dot--completed svg { width: 72%; height: 72%; fill: none; stroke: #062b0f; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 14; stroke-dashoffset: 14; animation: ll-check 0.45s ease-out 0.25s forwards; }
.ll-dot--current { border-color: var(--good); background: var(--bg); animation: ll-beacon 1.6s ease-out infinite; }
.ll-dot--awaiting { border-color: var(--warn); border-style: dashed; background: var(--bg); }
.ll-dot--awaiting b { color: var(--warn); font-size: 0.8em; font-weight: 900; line-height: 1; }
.ll-dot--upcoming { border-color: var(--border-strong); background: var(--bg); }
.ll-dot--mini { width: 0.95em; height: 0.95em; border-width: 1.5px; animation: none !important; box-shadow: none; }
.ll-dot__label { color: var(--text-2); font-size: 0.85em; font-weight: 700; white-space: nowrap; }
.ll-dot__label.is-now { color: var(--good); font-weight: 800; }

.ll-card__stats { display: flex; justify-content: space-between; margin: 0; font-size: 0.95em; }
.ll-card__stats div { display: flex; gap: 0.35em; }
.ll-card__stats dt { color: var(--muted); }
.ll-card__stats dd { margin: 0; font-weight: 800; }
.ll-strip { display: flex; justify-content: space-between; gap: 0.6em; padding: 0.32em 0.7em; border-radius: 0.5em; font-weight: 700;
  white-space: nowrap; overflow: hidden; animation: ld-slide 0.4s ease both; }
.ll-strip span { overflow: hidden; text-overflow: ellipsis; }
.ll-strip--stopped { background: linear-gradient(90deg, #b52a2a, var(--crit)); color: #fff; box-shadow: 0 0 1em rgba(208,59,59,0.35); }
.ll-note-awaiting { display: flex; align-items: center; gap: 0.5em; color: var(--warn); font-weight: 700; font-size: 0.95em;
  white-space: nowrap; overflow: hidden; }
.ll-note-awaiting span { overflow: hidden; text-overflow: ellipsis; }
.ll-note-awaiting i { flex: none; width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--warn); }

@keyframes ll-in { from { opacity: 0; transform: translateY(1em) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ll-flow { from { background-position: 200% 0; } to { background-position: 0 0; } }
@keyframes ll-alarm { 0%, 100% { box-shadow: 0 0 0.8em rgba(208,59,59,0.18); } 50% { box-shadow: 0 0 2em rgba(208,59,59,0.45); } }
@keyframes ll-pop { 0% { transform: scale(0.3); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes ll-check { to { stroke-dashoffset: 0; } }
@keyframes ll-beacon { 0% { box-shadow: 0 0 0 0 rgba(57,135,229,0.7); } 100% { box-shadow: 0 0 0 0.75em rgba(57,135,229,0); } }

/* ── Motion ── */
@keyframes ld-spin { to { transform: rotate(360deg); } }
@keyframes ld-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ld-rise { from { opacity: 0; transform: translateY(0.8em); } to { opacity: 1; transform: none; } }
@keyframes ld-slide { from { opacity: 0; transform: translateX(-0.8em); } to { opacity: 1; transform: none; } }
@keyframes ld-ping { 0% { transform: scale(1); opacity: 0.7; } 100% { transform: scale(2.8); opacity: 0; } }
@keyframes ld-ring { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(3); opacity: 0; } }
@keyframes ld-blink { 50% { opacity: 0.25; } }
@keyframes ld-breathe { 50% { opacity: 0.7; } }
@keyframes ld-dash { to { stroke-dashoffset: -28; } }
@media (prefers-reduced-motion: reduce) {
  .ld *, .ld *::before, .ld *::after { animation: none !important; transition: none !important; }
}

/* Portrait / narrow windows: stack and scroll instead of crushing the TV layout. */
@media (max-aspect-ratio: 4/3) {
  .ld { font-size: 14px; overflow: auto; }
  .ld-header { flex-wrap: wrap; }
  .ld-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-grid { grid-template-columns: 1fr; grid-template-rows: none; grid-auto-rows: 24em; flex: none; }
  .ld-span2 { grid-column: auto; }
}
`;
