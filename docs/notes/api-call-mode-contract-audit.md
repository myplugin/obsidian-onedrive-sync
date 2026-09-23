# API Call-Mode Contract Re-Audit

Project-independent knowledge — a recurring trap when integrating external APIs.

## The pattern

Switching HOW an external API is called — full→incremental, list→delta, item→batch, v1→beta, endpoint change, permission scope change — can cross from one **response contract** into a **different** one, where fields the code previously assumed-always-present are now omitted.

## Why it's dangerous

The failure is invisible to every common safety net:

| Safety net | Why it can't see it |
|---|---|
| `git diff` | The field NAME hasn't changed — only its presence contract did. |
| Typecheck | The field is typed `string` (or `string \| undefined`) in both modes; the type can't encode "present in mode A, absent in mode B." |
| Happy-path tests | Fixtures carry the field (captured in mode A); the omission only shows under mode B's actual responses. |

The **only** place the omission is visible: the endpoint's docs **Remarks/notes** section — sentences like *"may be omitted / nullable / conditional / track by id / you should always"*. Exactly the section everyone skips.

## Real example

OneDrive `driveItem: delta` has documented since 2015: *"The `parentReference` property on items won't include a value for path… track items by id."* Code written for full-enumeration mode assumed `parentReference.path` always present (empirically true in full mode). Switching to incremental delta (reusing `deltaLink` as token) crossed into the contract where `path` is omitted — the converter threw on the root-folder item. Diff, typecheck, and happy-path tests all stayed green. Only the docs Remarks revealed it.

## Audit checklist (when changing call mode)

Any change to HOW an external API is invoked MUST pass these four gates:

1. **Re-read endpoint Remarks** for the NEW call mode — especially "may be omitted / nullable / conditional / track by id / you should always" sentences.
2. **Field-dependency audit**: list every field the code depends on; confirm each is documented-present under the new mode. Mark fields with no doc guarantee (only "empirically present") as fragile + add a fallback.
3. **Contract delta**: produce an "old response contract vs new response contract" diff. Without this, an optimization/refactor should be blocked.
4. **Spec-driven fixtures**: for each "may be absent / nullable" claim in the docs, add a fixture test that goes red on the day the switch lands.

## Hard rule

> Writing external-API integration code without first fetching the official docs (context7/librarian) and quoting the relevant Remarks in the plan is a contract violation. Treat "you should always / may be omitted / nullable / conditional" in docs as a hard constraint — reading it and then writing a no-fallback field access is a self-flagged violation.
