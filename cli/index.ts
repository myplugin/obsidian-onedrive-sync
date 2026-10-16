// Headless CLI entry point (Phase C Milestone C1b).
//
// Hand-rolled argv — NO commander/yargs dep (avoids package.json + gate-
// check churn for a 3-subcommand tool). process.argv[2] is the subcommand.
//
// Commands:
//   ods login [--vault-name X]            → loginCommand (DCF → save config)
//   ods sync --vault <path> --once        → syncCommand (full syncer wiring)
//   ods status                            → loadConfig → print auth summary
//
// Unknown / no args → usage + exit 1.
// --dry-run / --watch are recognized but print "unsupported" (--once first;
// Q3 scope).

// MUST be first — sets window.moment before any src module the subcommands
// import (sync.ts / login.ts pull baseTypes → unixTimeToStr → window.moment).
import "./polyfills";

import { loginCommand } from "./login";
import { syncCommand } from "./sync";
import { loadConfig, DEFAULT_CONFIG_PATH } from "./config";

function printUsage(): void {
  console.log(`Usage:
  ods login [--vault-name <name>]
  ods sync --vault <path> --once
  ods status`);
}

// Parse a minimal `--flag value` / `--flag` grammar from argv[3..].
// Returns a Map of flag → value (true for value-less flags). Unknown tokens
// are collected as positional args. Good enough for the 3 subcommands.
function parseFlags(args: string[]): {
  flags: Map<string, string | boolean>;
  positional: string[];
} {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      // If next exists and isn't itself a flag, treat as the value.
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === undefined) {
    printUsage();
    process.exit(1);
  }

  switch (cmd) {
    case "login": {
      const { flags } = parseFlags(argv.slice(1));
      const vaultName =
        (typeof flags.get("vault-name") === "string" &&
          (flags.get("vault-name") as string)) ||
        "cli";
      await loginCommand(DEFAULT_CONFIG_PATH, { vaultName });
      break;
    }

    case "sync": {
      const { flags } = parseFlags(argv.slice(1));
      // --dry-run / --watch are out of scope for C1b (--once first).
      if (flags.has("dry-run") || flags.has("watch")) {
        console.log("unsupported: --dry-run / --watch not implemented yet");
        process.exit(1);
      }
      const vaultPath = flags.get("vault");
      if (typeof vaultPath !== "string" || vaultPath === "") {
        console.error("sync requires --vault <path>");
        printUsage();
        process.exit(1);
      }
      await syncCommand(DEFAULT_CONFIG_PATH, { vaultPath });
      break;
    }

    case "status": {
      const config = await loadConfig(DEFAULT_CONFIG_PATH);
      const od = config.onedrive;
      const username = od.username || "(not logged in)";
      const hasRefresh = od.refreshToken && od.refreshToken !== "";
      const expiryMs = od.accessTokenExpiresAtTime;
      const expiryStr =
        expiryMs > 0
          ? `${new Date(expiryMs).toISOString()} (${expiryMs > Date.now() ? "valid" : "expired"})`
          : "(never)";
      console.log(`onedrive:
  username:        ${username}
  accessToken:     ${od.accessToken ? "(present)" : "(none)"}
  refreshToken:   ${hasRefresh ? "present" : "absent"}
  token expiry:    ${expiryStr}
  serviceType:     ${config.serviceType}`);
      break;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
