# OAuth2 Access vs Refresh Tokens (Microsoft identity)

Project-independent reference, gathered 2026-10-09.

## The two token types

After a successful OAuth2 authorization (this project uses the **PKCE** flow against the Microsoft identity v2.0 endpoint `/oauth2/v2.0/token`, tenant `consumers`), the token endpoint returns two distinct tokens:

- **access_token** — short-lived (typically ~1 hour, `expires_in`). This is the bearer credential actually sent on each API call (e.g. to Microsoft Graph). Treat as ephemeral.
- **refresh_token** — long-lived. Used to mint NEW access_tokens WITHOUT re-prompting the user to log in. This is what lets a client "stay logged in" across days/weeks.

## Refresh flow (grant_type=refresh_token)

POST to the token endpoint with `grant_type=refresh_token` + the current refresh_token (+ `client_id`, `scope`). The response contains a fresh `access_token` AND a (typically) rotated `refresh_token`. Microsoft uses **refresh-token rotation**: each refresh issues a new refresh_token, so the stored value changes over time. Persisting the rotated token on each refresh is required for continued operation.

## Local expiry / force-expire

Even though refresh tokens are long-lived, a client can force a local expiry. This project force-expires locally after 80 days (`OAUTH2_FORCE_EXPIRE_MILLISECONDS = 1000*60*60*24*80`), tracked via a `credentialsShouldBeDeletedAtTime` timestamp. After that, the connection is treated as stale and re-auth is required.

## Transferability

The refresh_token IS the transferable "connection" — possessing it (plus the `client_id`/`authority`) lets a new client mint access_tokens as that user without the browser OAuth dance. The access_token is NOT worth transferring (it expires in ~1 hour; the target can just refresh). This asymmetry is why credential-transfer features export the refresh_token, not the access_token.
