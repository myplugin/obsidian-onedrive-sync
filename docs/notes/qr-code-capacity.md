# QR Code Capacity & Encoding (qrcode npm lib)

Project-independent reference, gathered 2026-10-09.

## Capacity by error-correction level

The `qrcode` library's `toDataURL(text)` defaults to error-correction level **M**. For a version-40 (largest) QR in **byte mode**, the raw byte caps are approximately:

| ECC level | Raw byte cap |
|---|---|
| L (low)      | ~2953 |
| M (medium)   | ~2331 | ← library default
| Q (quartile) | ~1663 |
| H (high)     | ~1273 |

These are RAW bytes of the payload. Effective capacity is lower once you account for the character mix (see below).

## Character mix matters more than raw byte count

A QR encodes the payload in one of several modes; byte mode is the catch-all but least dense. A payload of mixed URL/JSON characters (lots of `%`-triples from `encodeURIComponent`, plus `{`, `}`, `"`, `,`) packs worse than a pure alphanumeric payload of the same length. Empirically, a `%`-heavy URL-encoded JSON payload of ~2371 bytes FAILED at ECC M (raw cap ~2331) even though a pure-alphanumeric payload of the same length fit — the effective `%`-heavy M cap is below the raw number.

When testing whether a payload will fit, test the ACTUAL character mix, not just the byte length.

## encodeURIComponent inflation

`encodeURIComponent` %-encodes every non-URL-safe char as `%XX` (3 bytes for 1). JSON structure is full of such chars: `{` `}` `"` `,` `:` → each triples. A 1669-byte plain-JSON settings object became 2303 bytes after `encodeURIComponent` (317 %-triples, +634 bytes). Plan for ~1.4× expansion when the payload is JSON.

High-entropy tokens that are already URL-safe (base64url: `A-Za-z0-9-_` `.` `~`) do NOT get %-encoded — they pass through ~1:1. So a long refresh token adds roughly its own length to the URI, not tripled.

## When compression helps (and when it doesn't)

`deflate`/`gzip` on a small (~1–3 KB) JSON payload:

- Structural JSON (repetitive field names, booleans, string arrays): compresses 3–4×.
- High-entropy tokens (OAuth refresh tokens, opaque cursors): **incompressible** (~1×, maybe slightly negative from overhead).
- Then base64-encoding the compressed binary **re-inflates 33%**, partially offsetting the structural win.

Net: compression helps the structure but not the dominant high-entropy token. If a single mandatory incompressible token (refresh token) is 1–2 KB and the QR cap is ~3 KB, compression's incremental benefit is modest (~0.2–0.4 KB more headroom), not a guaranteed fix.

## Multi-QR splitting is the only guaranteed fit

If a payload must ALWAYS render as a QR regardless of size, the only robust approach is **splitting into multiple QR codes** (chunk the payload, export N QRs, import reassembles in order). Single-QR capacity is fundamentally bounded; no amount of ECC tuning or compression guarantees a fit for an arbitrary-length token. Prefer single-QR + copy-URI fallback for the common case, and reserve multi-QR for when QR-only transfer is mandatory.
