# Export Sync Decision Records

## What's this?

Everytime the plugin starts a sync, it gathers all required information together, generates a "sync plan" of every operation to every file and folder, and assigns the corresponding actual operations.

Thus, if something goes wrong, we should check the sync plan firstly.

## How To Export The Records?

Please read through the following instructions.

### Disable Auto Sync Firstly

You should disable auto sync to avoid any unexpected running.

### Manual Sync If Not Yet

You should at least sync once, so that at least one sync plan is generated and saved. If you have synced the vault before, there should be some sync plans already saved.

### Export To The File

Go to the plugin settings, scroll down to the section "Debug" -> "export sync plans", and click a button such as "Latest 1". It generates a new folder `_onedrive_sync_debug/` in your vault, and writes a file named `sync_decisions_exported_on_{a_timestamp}.json` inside that folder.

Note: the folder used to be named `_debug_remotely_save/` in older versions. Both the current and the legacy folder are always excluded from sync.

## How To Read The Records

The exported file is a single JSON object:

```json
{
  "exportedAt": 1646960867560,
  "onlyChange": false,
  "count": 1,
  "plans": [
    {
      "/$@meta": { "...": "..." },
      "abc.md": {
        "key": "abc.md",
        "decision": "skipUploading",
        "decisionBranch": 1,
        "change": false,
        "local": { "...": "..." },
        "prevSync": { "...": "..." },
        "remote": { "...": "..." }
      }
    }
  ]
}
```

- `exportedAt` — when the export ran.
- `onlyChange` — whether only the changed items were kept.
- `count` — how many sync plans are included in `plans`.
- `plans` — one entry per recorded sync plan. Each plan is an object keyed by vault-relative path (`"/$@meta"` holds plan-level metadata); every other entry represents a file or folder.

For the path you are interested in (or believe something goes wrong), check the following properties:

```
decision
  What decision is made.

decisionBranch
  It's a mark of the actual logic in the sync code. Useful to debug.

change
  Whether this item actually changes in this sync (i.e. whether the decision
  results in a transfer or deletion). When you export with a
  "(changes only)" button, unchanged items are dropped.

local / prevSync / remote
  The gathered local state, the previous-sync state, and the remote state.
```

The `decision` SHOULD be determined by the modified times and deletion times, by the logic described in [the doc of sync algorithm](../sync_algorithm/v3/intro.md). In short, we collect the timestamps of each side and respect the max timestamp and its corresponding operation.

## Common Issues

Some users report that their "last modified time"s or "creation time"s are not set correctly by the operating system. In this case, the plugin cannot do anything because it determines the sync plan by comparing the timestamps. It's suggested to check the settings of the operating system or check whether other programs are doing something to the files.
