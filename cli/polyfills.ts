// Headless CLI window.moment polyfill (Phase C Milestone C0).
//
// THE BLOCKER THIS RESOLVES:
//   src/misc.ts:355,358  unixTimeToStr calls
//     window.moment(x).toISOString(true)   // hasMs branch
//     window.moment(x).format()            // !hasMs branch
//   sync.ts (67/74/81/88/1275), localdb.ts:365, profiler.ts:129 all call
//   unixTimeToStr at runtime. The CLI has no `window` global (and Obsidian's
//   `window.moment` is a full moment.js instance) → every sync-time date
//   format throws ReferenceError. This module installs a MINIMAL shim covering
//   EXACTLY the two methods unixTimeToStr calls, so misc.ts and the plugin
//   stay untouched (Rule 2: do not refactor misc.ts — that changes the plugin
//   date format; do not set globalThis.window=globalThis — over-exposes Node
//   globals).
//
// DIVERGENCE FROM REAL moment (DOCUMENTED, ACCEPTABLE):
//   - moment's `toISOString(true)` keeps the local timezone offset (e.g.
//     '2024-05-26T16:29:22+08:00'); the shim's native `new Date(x).toISOString()`
//     is ALWAYS UTC ('...Z'). Divergence is safe because unixTimeToStr's output
//     feeds ONLY display-only `*Fmt` fields — sync logic reads the NUMERIC
//     `*Cli` / `*Svr` timestamps (ms epochs), never the formatted `*Fmt` string,
//     so a UTC-vs-offset difference cannot affect sync correctness. (If a later
//     code path depends on the offset, extend this shim deliberately.)
//   - moment's `.format()` default is locale-specific (e.g. '2024-05-26T16:29:22+08:00');
//     the shim returns ISO ('...Z') as a stand-in. Same display-only caveat.
//
// SIDE-EFFECT MODULE: importing it installs the global. MUST be imported FIRST
// (before any src module whose module-load or runtime path calls unixTimeToStr).
// Guarded against double-install.

// Minimal moment shim: covers EXACTLY toISOString(keepOffset?) + format().
function momentShim(
  input: number | string | Date,
): {
  toISOString: (keepOffset?: boolean) => string;
  format: () => string;
} {
  // Native Date accepts number epoch-ms, ISO strings, and Date instances —
  // the only inputs unixTimeToStr passes (it always calls with a number `x`,
  // but accept the broader set for safety).
  const d = new Date(input);
  return {
    // keepOffset is accepted but IGNORED — native toISOString() is UTC. See
    // the DIVERGENCE note above (display-only *Fmt fields; sync reads numerics).
    toISOString: (_keepOffset?: boolean) => d.toISOString(),
    format: () => d.toISOString(),
  };
}

// Guard against double-install: if window already has a moment (this module
// re-imported, or another Phase C polyfill ran), leave it — don't clobber a
// potentially-richer shim with this minimal one.
//
// NOTE: we deliberately do NOT `declare global { var window: unknown }` —
// that would clash with the DOM lib's `window` (TS2403). Instead every
// read/write of the global goes through an inline `globalThis` cast below.

// The window object exposes: the moment shim (for unixTimeToStr) AND the Node
// timers (setTimeout/clearTimeout). src/deviceCode.ts uses `window.setTimeout`
// per the project's obsidianmd/prefer-window-timers rule — which the project's
// eslint config FORBIDS disabling (eslint-comments/no-restricted-disable) — so
// the shared module MUST use window.setTimeout; this polyfill exposes the real
// Node timers under `window.` so it works in the CLI too (Node has no `window`).
const windowShim = {
  moment: momentShim,
  setTimeout,
  clearTimeout,
};

if (
  typeof (globalThis as { window?: unknown }).window === "undefined" ||
  (globalThis as { window?: { moment?: unknown } }).window === undefined
) {
  (globalThis as { window: unknown }).window =
    windowShim as unknown as typeof globalThis.window;
} else {
  // window exists already — add any missing keys (don't overwrite present
  // ones, in case a richer shim already installed some).
  const existing = (globalThis as { window: Record<string, unknown> }).window;
  for (const [k, v] of Object.entries(windowShim)) {
    if (typeof existing[k] === "undefined") {
      existing[k] = v;
    }
  }
}

export {};
