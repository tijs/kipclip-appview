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
app uses Hono with runtime adapters, a React 19 SPA frontend, and local libSQL
for sessions, settings, imports, and mirrored records.

Key patterns:

- All bookmark data lives on the user's PDS, not our database
- OAuth sessions managed via encrypted cookies
- Frontend uses an AppContext provider with cache layer for offline-first UX
- AT Protocol TIDs are base32-encoded timestamps used as record keys
