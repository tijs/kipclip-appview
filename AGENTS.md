# Agent guide

<!-- kiem -->

This repo is Kiem project `proj/kipclip_appview`. Run `kiem todos` /
`kiem notes` for project state, and record progress with `kiem note add` /
`kiem todo check`.

## Project context

kipclip is a bookmark manager for the AT Protocol ecosystem. Users authenticate
via Bluesky OAuth and store bookmarks on their personal data server (PDS).

Key patterns:

- Fresh 2.x (Deno) backend with a React 19 SPA frontend.
- Bookmark data lives on the user's PDS; the local DB mirrors tracked users for
  reads.
- OAuth sessions are managed via encrypted cookies.
- Frontend uses an AppContext provider with a cache layer for offline-first UX.
- AT Protocol TIDs are base32-encoded timestamps used as record keys.
