---
title: "feat: Bulk bookmark operations"
type: feat
status: completed
date: 2026-02-28
---

# Bulk Bookmark Operations

## Overview

Add multi-select and bulk operations for bookmarks: bulk delete, bulk add
tag(s), and bulk remove tag(s). Users enter "select mode" via a toggle button in
the header, checkboxes appear on all bookmark cards, and a floating action
toolbar at the bottom shows available actions when 1+ bookmarks are selected.

## Proposed Solution

### Architecture

- **Selection state** lives in `BookmarkList` component (not AppContext) since
  it's a transient UI mode, not shared app state. The floating toolbar renders
  inside `BookmarkList` as a fixed-position div.
- **Bulk API endpoint** on the backend (`POST /api/bookmarks/bulk`) handles
  batching via `applyWrites` (max 10 ops per call), matching the proven import
  flow pattern.
- **Frontend calls one endpoint**, backend handles batching, error tracking, and
  returns a result summary.

### Key Decisions

| Decision                       | Choice                                           | Rationale                                                                            |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Selection state location       | `BookmarkList` local state                       | Transient UI mode, no need to pollute AppContext                                     |
| Selection identity             | Bookmark URI (`at://...`)                        | Stable across re-renders and list reordering                                         |
| Backend vs frontend batching   | New backend endpoint                             | Better error handling, rate limit control, matches import pattern                    |
| Annotation deletes             | Fire-and-forget (separate from bookmark deletes) | Matches existing single-delete behavior at line 563-575 of `routes/api/bookmarks.ts` |
| "Select all" scope             | Only `filteredBookmarks` (visible)               | User intent is to act on what they see                                               |
| Drag-and-drop in select mode   | Disabled                                         | Avoids ambiguity about single vs multi-bookmark tag drop                             |
| Card click in select mode      | Toggles selection (not detail view)              | Standard multi-select UX pattern                                                     |
| Pull-to-refresh in select mode | Disabled                                         | Prevents accidental data reload invalidating selection                               |
| Reading List view              | Not included in v1                               | Scope control; can add later                                                         |
| After bulk operation completes | Auto-exit select mode                            | Clean UX reset                                                                       |

## Implementation Phases

### Phase 1: Backend — Bulk API Endpoint

Create `routes/api/bulk.ts` with a single `POST /api/bookmarks/bulk` endpoint.

**Request format:**

```typescript
// shared/types.ts
interface BulkOperationRequest {
  action: "delete" | "add-tags" | "remove-tags";
  uris: string[]; // bookmark URIs to operate on
  tags?: string[]; // tags to add/remove (required for tag actions)
}

interface BulkOperationResponse {
  success: boolean;
  succeeded: number;
  failed: number;
  errors?: string[]; // error messages for failed items
  bookmarks?: EnrichedBookmark[]; // updated bookmarks (for tag operations)
}
```

**Implementation details:**

- Extract rkeys from URIs (`uri.split("/").pop()`)
- For **delete**: batch bookmark deletes into `applyWrites` calls (10 ops per
  call). Annotation deletes are fire-and-forget after, matching existing
  pattern.
- For **add-tags**: fetch all target bookmark records via `getRecord` calls (5
  concurrent), merge new tags, then batch `applyWrites` updates. Also update
  annotation records for tag storage. Create new tag records if tags don't exist
  yet.
- For **remove-tags**: same as add-tags but filter out the specified tags
  instead of merging.
- For **delete**: return `{ success, succeeded, failed }` counts only.
- For **tag operations**: return updated `EnrichedBookmark[]` in the response so
  the frontend can update AppContext without a full reload.
- Skip Instapaper integration for bulk operations (too noisy).

**Files:**

- `routes/api/bulk.ts` (new, ~150 lines)
- `main.ts` (register new route)
- `shared/types.ts` (add request/response types)

### Phase 2: Frontend — Selection State, Select Mode & Header Button

Add select mode to `BookmarkList` with local state, and the header toggle button
to enter/exit it.

**New state in `BookmarkList`:**

```typescript
const [isSelectMode, setIsSelectMode] = useState(false);
const [selectedUris, setSelectedUris] = useState<Set<string>>(new Set());
```

**Selection helpers (in BookmarkList):**

```typescript
function toggleSelection(uri: string) {
  setSelectedUris((prev) => {
    const next = new Set(prev);
    if (next.has(uri)) next.delete(uri);
    else next.add(uri);
    return next;
  });
}

function selectAll() {
  setSelectedUris(new Set(bookmarks.map((b) => b.uri)));
}

function deselectAll() {
  setSelectedUris(new Set());
}

function exitSelectMode() {
  setIsSelectMode(false);
  setSelectedUris(new Set());
}
```

**Behavior changes in select mode:**

- `BookmarkCard` `onClick` toggles selection instead of opening detail
- Drag-and-drop handlers become no-ops
- Pull-to-refresh touch handlers are skipped
- "Select" button in header changes to "Cancel"

**Header "Select" button:**

- **Desktop header**: Add "Select" button between the title and "+ Add Bookmark"
  button. In select mode, it becomes "Cancel".
- **Mobile header**: Add "Select" button in the icon row. In select mode, hide
  Add/Search buttons and show "Cancel" instead.
- Hide the "Select" button when no bookmarks exist or a modal is open.

**Files:**

- `frontend/components/BookmarkList.tsx` (modify)

### Phase 3: Frontend — BookmarkCard Checkbox

Add optional checkbox rendering to `BookmarkCard`.

**New props:**

```typescript
interface BookmarkCardProps {
  // ... existing props
  isSelectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}
```

**Checkbox rendering:**

- In select mode, render an `<input type="checkbox">` at the left side of the
  card
- Cards view: checkbox overlaid in top-left corner with semi-transparent
  background
- List view: checkbox as first element in the row, before favicon
- Selected cards get a subtle blue border/background
  (`border-blue-500
  bg-blue-50`)
- Checkbox is a real `<input type="checkbox">` for accessibility

**Files:**

- `frontend/components/BookmarkCard.tsx` (modify)

### Phase 4: Frontend — Floating Action Toolbar

New component rendered inside `BookmarkList` when `selectedUris.size > 0`.

**`BulkActionToolbar` component:**

```
+----------------------------------------------------------+
|  3 selected  |  Select All  |  Add Tag  Remove Tag  Delete|
+----------------------------------------------------------+
```

- Fixed position at bottom of viewport, centered, `z-30` (below pull-to-refresh
  z-40, below modals z-50)
- Shows count of selected items
- "Select all" / "Deselect all" toggle
- Action buttons: Add Tag, Remove Tag, Delete
- Delete button is red/destructive styled
- Slides up with CSS transition when appearing

**Delete flow:**

1. User clicks Delete
2. Custom confirmation modal: "Delete N bookmarks? This cannot be undone."
3. On confirm: call `POST /api/bookmarks/bulk` with `action: "delete"`
4. Show spinner in toolbar during operation
5. On success: remove deleted URIs from AppContext via `deleteBookmark()` calls,
   exit select mode
6. On partial failure: show "X deleted, Y failed" message, keep select mode
   active with failed items still selected

**Add Tag flow:**

1. User clicks "Add Tag"
2. Modal with `TagInput` component (reuse existing) for selecting/creating tags
3. On submit: call `POST /api/bookmarks/bulk` with `action: "add-tags"`
4. On success: update AppContext bookmarks from response `bookmarks[]` via
   `updateBookmark()` calls, reload tags, exit select mode

**Remove Tag flow:**

1. User clicks "Remove Tag"
2. Modal showing only tags that appear on ALL selected bookmarks (intersection)
3. User selects which tags to remove
4. On submit: call `POST /api/bookmarks/bulk` with `action: "remove-tags"`
5. On success: update AppContext bookmarks from response `bookmarks[]` via
   `updateBookmark()` calls, reload tags, exit select mode

**Confirmation dialog:** The delete confirmation renders inline inside
`BulkActionToolbar` as conditional state (no separate component needed).

**Files:**

- `frontend/components/BulkActionToolbar.tsx` (new, ~200 lines)
- `frontend/components/BulkTagModal.tsx` (new, ~120 lines)
- `frontend/components/BookmarkList.tsx` (integrate toolbar)

### Phase 5: Keyboard & Accessibility

- Escape key exits select mode (add to existing keyboard listener pattern)
- Checkboxes are real `<input type="checkbox">` with `aria-label`
- Floating toolbar has `role="toolbar"` and `aria-label="Bulk actions"`
- Selection count announced via `aria-live="polite"` region
- Confirmation modal is focusable and traps focus

**Files:**

- `frontend/components/BookmarkList.tsx` (keyboard handler)
- `frontend/components/BulkActionToolbar.tsx` (ARIA attributes)
- `frontend/components/BookmarkCard.tsx` (checkbox accessibility)

## Acceptance Criteria

### Functional

- [x] "Select" button in header enters select mode; "Cancel" exits it
- [x] Checkboxes appear on all visible bookmark cards in select mode
- [x] Clicking a card in select mode toggles its checkbox
- [x] Floating toolbar appears at bottom when 1+ bookmarks selected
- [x] "Select all" selects all currently visible (filtered) bookmarks
- [x] "Deselect all" clears all selections
- [x] Toolbar shows count of selected items
- [x] Bulk delete: confirmation dialog, then deletes all selected + annotations
- [x] Bulk add tag: tag picker modal, adds tag(s) to all selected bookmarks
- [x] Bulk remove tag: shows intersection tags, removes selected tag(s)
- [x] Partial failures show "X succeeded, Y failed" message
- [x] Select mode works in both card and list view modes
- [x] Drag-and-drop disabled during select mode
- [x] Pull-to-refresh disabled during select mode
- [x] Escape key exits select mode
- [x] Exiting select mode or completing an operation clears selection

### Non-Functional

- [x] Checkboxes are accessible `<input type="checkbox">` elements
- [x] Toolbar has `role="toolbar"` and appropriate ARIA labels
- [x] Operations complete within reasonable time for 50 bookmarks
- [x] No visible jank when toggling selection on 200+ bookmark lists

## File Summary

| File                                        | Action | Lines (est.) |
| ------------------------------------------- | ------ | ------------ |
| `routes/api/bulk.ts`                        | New    | ~150         |
| `main.ts`                                   | Modify | +3           |
| `shared/types.ts`                           | Modify | +15          |
| `frontend/components/BookmarkList.tsx`      | Modify | +80          |
| `frontend/components/BookmarkCard.tsx`      | Modify | +30          |
| `frontend/components/BulkActionToolbar.tsx` | New    | ~200         |
| `frontend/components/BulkTagModal.tsx`      | New    | ~120         |
| `tests/bulk-api.test.ts`                    | New    | ~150         |

## Testing

- **Backend**: Test `POST /api/bookmarks/bulk` for each action type, partial
  failures, invalid input, auth required
- **Frontend**: Manual testing of select mode, toolbar interactions, keyboard
  shortcuts, mobile layout, both view modes

## References

- Import batching pattern: `routes/api/import.ts:267-320`
- Single delete pattern: `routes/api/bookmarks.ts:534-585`
- Single update pattern: `routes/api/bookmarks.ts:230-420`
- Tag toggle pattern: `frontend/context/AppContext.tsx:275-285`
- BookmarkCard component: `frontend/components/BookmarkCard.tsx`
- BookmarkList component: `frontend/components/BookmarkList.tsx`
