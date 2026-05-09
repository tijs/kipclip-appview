---
branch: feat/tag-sidebar-search-recent
review_run: 20260509-213515-ccc65902
review_mode: autofix
created: 2026-05-09
---

# Residual Review Findings — feat/tag-sidebar-search-recent

ce-code-review autofix run resolved all P0–P2 findings. The items below are
residual P3 polish that did not meet the autofix threshold and remain for human
or follow-up resolution. Source review summary:
`/tmp/compound-engineering/ce-code-review/20260509-213515-ccc65902/summary.md`

## Residuals

- **#6 — P3 / gated_auto** — `frontend/components/TagSidebar.tsx` (desktop and
  mobile search input sites). Extract a shared `<TagSearchInput>` subcomponent.
  The two inputs differ only in container padding (~25 lines duplicated each). A
  subcomponent prevents drift on future a11y or clear-button work and would let
  the next consumer pick it up without wading through both branches. Defer
  rationale: pure refactor, no behavior change, low value relative to the
  surface area touched in this PR.

- **#7 — P3 / gated_auto** — `frontend/components/TagSidebar.tsx`. Extract
  `filterTags(tags, query)` and `resolveRecentTags(tags, recent, isSearching)`
  into `frontend/utils/tag-sidebar-view.ts`. Enables pure unit tests for the
  silently-handled "deleted-tag drop" case (a recent entry whose underlying
  EnrichedTag was deleted from the user's library). Currently covered only by
  manual smoke-test. Defer rationale: behavior already correct; the test is a
  regression-safety net for a known invariant, not a bug fix.

- **#8 — P3 / manual** — `frontend/components/TagSidebar.tsx` mobile bar. The
  new search row currently sits between the horizontal tag scroll and the
  selected-actions row (Clear / Share collection). Worth a manual viewport check
  at 375px and 414px to decide whether search should sit _above_ the tag scroll
  instead of below. Discoverability vs. layout density trade-off. Defer
  rationale: requires human visual judgment on a phone.
