---
review_agents:
  - security-sentinel
  - performance-oracle
  - architecture-strategist
  - code-simplicity-reviewer
---

## Project Context

kipclip is a bookmark manager for the AT Protocol ecosystem. Users authenticate
via Bluesky OAuth and store bookmarks on their personal data server (PDS). The
app uses Fresh 2.x (Deno), React 19 SPA frontend, and Turso/libSQL for session
storage only.

Key patterns:

- All bookmark data lives on the user's PDS, not our database
- OAuth sessions managed via encrypted cookies
- Frontend uses an AppContext provider with cache layer for offline-first UX
- AT Protocol TIDs are base32-encoded timestamps used as record keys
