/**
 * Tiny debug-gated console logger.
 *
 * Obsidian's plugin guidelines ask plugins to avoid unnecessary logging to
 * the console, so every informational console message in this plugin goes
 * through the helpers below instead of calling console.log/console.info
 * directly. They only produce output when debug logging is enabled: main.ts
 * flips the flag from the user's `currLogLevel` setting ("debug" => on) at
 * load time, and the settings UI keeps it in sync when the level changes.
 *
 * The underlying calls use console.debug / console.warn / console.error —
 * exactly the console methods the repo's ESLint config (mirroring the
 * Obsidian scanner rules) allows — so this module is the single sanctioned
 * console output point and needs no lint suppressions.
 *
 * Genuine errors should still use console.error directly at the error site
 * (allowed by the same rule); debugWarn/debugError are for diagnostics that
 * only make sense in debug mode.
 *
 * Note: this module holds one tiny piece of module-level state (the flag) —
 * the sanctioned exception to the "keep src/ pure" convention, so deep
 * modules (fs*, sync, localdb) can log without threading settings through
 * every function signature. logger.ts itself imports nothing, so it can
 * never create a dependency cycle.
 */

let debugEnabled = false;

/** Enable/disable debug console output (wired to settings.currLogLevel). */
export const setDebugEnabled = (enabled: boolean) => {
  debugEnabled = enabled;
};

/** Whether debug console output is currently enabled. */
export const isDebugEnabled = () => debugEnabled;

/** Gated drop-in replacement for console.log. */
export const debugLog = (...args: unknown[]) => {
  if (debugEnabled) {
    console.debug(...args);
  }
};

/** Gated drop-in replacement for console.info. */
export const debugInfo = (...args: unknown[]) => {
  if (debugEnabled) {
    console.debug(...args);
  }
};

/** Gated drop-in replacement for console.warn. */
export const debugWarn = (...args: unknown[]) => {
  if (debugEnabled) {
    console.warn(...args);
  }
};

/** Gated drop-in replacement for console.error. */
export const debugError = (...args: unknown[]) => {
  if (debugEnabled) {
    console.error(...args);
  }
};
