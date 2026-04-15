# TODO

## Current Focus

- [x] Keep shrinking `src/core/DiffEditorManager.ts` only where the next slice is low-coupling and behavior-preserving.
- [x] Extract unchanged-region reveal button wiring and bridge wheel handling into helpers.
- [x] Extract the remaining center activation / click-flow glue into helpers if it can stay stateless.
- [x] Re-evaluate the unchanged-region area after each slice and stop once the remaining code is mostly orchestration.

## Validation Plan

- [x] Run `pnpm lint`.
- [x] Run `pnpm typecheck`.
- [x] Run targeted unchanged-region presentation tests first.
- [x] Run the full `pnpm vitest run` suite after each landed slice.

## Remaining Follow-ups

- [x] Decide whether `DiffEditorManager` should stop here or split one level further by responsibility.
- [ ] Keep `src/index.base.ts` as orchestration only and avoid reintroducing editor update logic there.
- [ ] If a future unchanged-region feature touches this area again, prefer another stateless DOM/helper slice before growing `DiffEditorManager` in place.
- [x] Audit `clearHighlighterCache()` semantics against the other shared highlighter state.
- [x] Align `README.md`, `package.json`, `CHANGELOG.md`, and release workflow version story.
- [x] Add at least one Playwright smoke job to CI.
- [x] Add at least one real framework example (`React` or `Vue`) to match the package positioning.
- [x] Verify package side-effect metadata against the automatic worker hook behavior.
- [x] Verify the build target / platform choices and document the reason if they stay as-is.
