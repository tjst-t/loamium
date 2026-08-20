impl-sf-batch2 — 2026-07-08

## Items implemented

### Item 4 (BUG — priority): Bookmark unbookmark leaves `bookmark: true` in open editor
- Root cause: `BookmarkStar.tsx` toggled the star and wrote to disk but never refreshed the editor.
- Fix: Added `onChanged?: () => void` prop to `BookmarkStar`. After a SUCCESSFUL
  `api.setNoteProperties` response, `onChanged?.()` is called.
- In `App.tsx`, `onChanged` triggers `api.getNote(currentDoc.path)` then `setOpenDoc(...)`,
  syncing the editor content, mtime, and frontmatter with the updated file.
- Tests added to `bookmark-star.mock.spec.ts`: 2 new mock tests asserting that the
  `properties-widget` appears after bookmarking and disappears after unbookmarking.
- E2E test added to `bookmark-star.e2e.spec.ts` (AC-S8086d9-2-4): verifies star + editor
  content sync end-to-end.

### Item 5: `make samples` seeds default smart folders
- Added `mkdir -p "$$DEST/.loamium"` and `[ -f ... ] || cp samples/smart-folders.json ...`
  to the `samples:` Makefile target.
- Verified: first run creates `.loamium/smart-folders.json`; second run does NOT overwrite.

### Item 2: folder-pin child files render same as query-folder child files
- `SmartFolderPin`'s outer container was `smart-pin-row` (display: flex, row direction),
  causing children to flow horizontally next to the header instead of below it.
- Changed to use `smart-folder-wrap` (block, same as `SmartFolder`).
- Changed inner button from `smart-pin-btn` to `smart-folder-btn` to match `SmartFolder`.
- Both `SmartFolder` and `SmartFolderPin` now render `SmartNoteRow` items in identical
  `tree-children smart-folder-body` wrappers with same CSS/indentation.

### Item 1: Unify header create buttons between note mode and smart mode
- Imported `PlusIcon` in `App.tsx`.
- Smart mode: replaced plain `+` text button (with `smart-view-add-btn` class) with
  `icon-btn` + `<PlusIcon />` (matching physical mode style).
- Reordered smart-mode buttons: `<NewNoteIcon />` (new file) first, `<PlusIcon />` (add
  smart folder) second — mirrors physical mode (`<NewNoteIcon />`, `<NewFolderIcon />`).
- Both modes now use SVG icons in `icon-btn` containers, right-aligned.
- Testids (`smart-view-add`, `smart-view-newfile`) preserved.

### Item 3: DnD drop indicator
- Extended `DragItemProps` interface with `onDragLeave`, `onDragEnd`, `dropIndicator`.
- `handleDragOver` now takes `id` parameter and computes `before`/`after` position from
  `clientY` vs element midpoint; stores in `dropTarget` state.
- `clearDropTarget` callback clears `dropTarget` on `dragend`/`dragleave`.
- `handleDrop` clears `dropTarget` before executing the reorder.
- `SmartFolder`, `SmartFolderPin`, `SmartPin` all render:
  - CSS classes `smart-drop-before` / `smart-drop-after` on outer container.
  - `data-testid="smart-drop-indicator"` element before or after content.
- Added CSS: `.smart-drop-indicator` (2px accent-colored line), `.smart-drop-before`/
  `.smart-drop-after` border rules.
- Test added: `[AC-batch2-3]` in `smart-folder-editor.mock.spec.ts` — simulates drag
  with mouse events and asserts indicator appears during drag and disappears after drop.

## Test results
- `make lint`: PASS (all workspaces)
- `npx playwright test --project=mock`: 198 passed
- New mock tests: 2 bookmark editor-sync tests + 1 DnD indicator test

## Gates
- lint: PASS
- mock full regression: 198/198 passed
