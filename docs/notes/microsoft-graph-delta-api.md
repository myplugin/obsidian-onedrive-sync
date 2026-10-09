# Microsoft Graph `driveItem: delta` API Contract

Project-independent reference knowledge, gathered 2026-09-21.

## The core contract: `parentReference.path` is OMITTED in delta

Microsoft Graph's `driveItem: delta` endpoint **officially omits `parentReference.path`** from response items. The documented remark (unchanged since 2015, pre-Graph OneDrive API):

> *"The `parentReference` property on items won't include a value for **path**. This occurs because renaming a folder doesn't result in any descendants of the folder being returned from delta. **When using delta you should always track items by id.**"*

- Source: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- This is **general delta behavior**, not App-Folder-specific.
- The omission is **deliberate** (design choice tied to folder-rename semantics), not a bug.

## `itemReference` field guarantees (none are "always present")

From https://learn.microsoft.com/en-us/graph/api/resources/itemreference — the `parentReference` facet has **no "always-returned" guarantee** for any field:

| Field | Documented guarantee |
|---|---|
| `driveId` / `driveType` | "Only returned if the item is located in a drive." |
| `siteId` | "For OneDrive, this property is not populated." |
| `id` | Unique id; **no always-present promise** |
| `name` | Item name; **no always-present promise** |
| `path` | Percent-encoded navigable path; **no always-present promise** (and delta drops it per above) |

`driveItem.parentReference` itself is documented as *"Parent information, **if the item has a parent**"* — i.e. it can be absent for root / special folders.

## `$select` cannot resurrect contractually-dropped fields

Delta supports `$select`/`$expand`/`$top`. But `$select` **narrows** the returned property set; it does **not** force the service to populate fields it contractually omits:

- `$select=name,id` → only `name` + `id`; `parentReference` omitted entirely.
- `$select=parentReference` → you get the object, but `path` is **still absent** per the delta remark.
- No `$select` → default set; `parentReference` present but still **without `path`**.

**Implication:** if you need `parentReference.id` (for an id-walk fallback), include `parentReference` in `$select`; but never expect `parentReference.path` from delta.

## Additional delta omission tables

The delta doc also lists operation-specific omissions (on top of the path rule):

| Service | Operation | Properties omitted |
|---|---|---|
| OneDrive for Business | Create/Modify | `ctag` |
| OneDrive for Business | Delete | `ctag`, `name` |
| OneDrive (consumer) | Delete | `ctag`, `size` |

So for a **delete** on consumer OneDrive, `name` survives but `ctag`/`size` are gone; and `parentReference.path` is **always** gone regardless of operation.

## Special folders (approot)

- App Root (`approot`) is a **special folder** — "The application's personal folder. Usually in `/Apps/{Application Name}`." Uses `Files.ReadWrite.AppFolder` delegated permission; carries `specialFolder: { name: "approot" }`.
- Delta on App Root (`GET /me/drive/special/approot:/{dir}:/delta`) is **NOT in the documented HTTP request list** (the doc only lists `/drives/{id}/root/delta`, `/me/drive/root/delta`, etc.). The `approot:/delta` form is undocumented — empirically it returns `path` for non-root items, but the general "no path" rule still officially applies.

## Recommended approach: track by `id`

Per the doc ("track items by id"), reconstruct paths when `parentReference.path` is absent by **walking `parentReference.id` upward** through a known id→key map (built from the previous sync state). Microsoft's own `vscode-onedrive-browser` does exactly this:

```ts
if (item.parentReference.path) {
  return item.parentReference.path.slice(prefix) + '/' + item.name;
}
// path missing — fall back to parent id chain
const parent = this.results.get(item.parentReference.id);
return parent ? this.getPathForItem(parent) + '/' + item.name : item.name;
```

For the **modify case** (item existed in prev sync), a simpler fallback suffices: look up the item's OWN `id` in the prev id→key map → reuse the known key. New items without path remain genuinely unparseable (self-heal via full re-enumeration).

## Key takeaway

Under delta, **never assume `parentReference.path` (or any `itemReference` field) is present.** Track by `id`; treat `path` as an optional optimization, not a dependency. A converter that throws on missing `path` is fighting the documented contract.

## The `@odata.deltaLink` cursor (vs the path-omission contract above)

The delta API returns a **`@odata.deltaLink`** URL alongside (or at the end of) its page sequence. This is an **opaque server-issued cursor** encoding "everything up to this point has been seen." Persist it; on the next sync, request THAT URL (not the base delta endpoint) and Graph returns ONLY items changed since that cursor — the incremental sync.

- First sync (no deltaLink saved) → call the base delta endpoint → full enumeration; the response carries a deltaLink to save for next time.
- Subsequent syncs (deltaLink saved) → call the saved deltaLink → only changes.
- If the deltaLink has expired server-side, the delta query fails and the client must fall back to full enumeration (and save the fresh deltaLink).

### deltaLink is per-device sync state, NOT a transferable credential

The cursor encodes **this device's** sync position. It is meaningless on a different device whose local vault state differs: a device that imports a foreign deltaLink would believe "I've already synced everything up to cursor X" and SKIP fetching files it has never actually seen → silent data gaps. So deltaLink must never be transferred across devices in a settings-export/credential-transfer flow. A freshly-connected device should start with an empty deltaLink → full enumeration → reconcile its local state safely.

(This is distinct from the `parentReference.path` omission discussed above, which is a response-shape contract. The cursor is a state marker.)
