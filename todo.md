# TODO

## Current Focus

- [ ] Keep shrinking `src/core/DiffEditorManager.ts` only where the next slice is low-coupling and behavior-preserving.
- [ ] Extract unchanged-region reveal button wiring and bridge wheel handling into helpers.
- [ ] Extract the remaining center activation / click-flow glue into helpers if it can stay stateless.
- [ ] Re-evaluate the unchanged-region area after each slice and stop once the remaining code is mostly orchestration.

## Validation Plan

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run targeted unchanged-region presentation tests first.
- [ ] Run the full `pnpm vitest run` suite after each landed slice.

## Next Repo Tasks

- [ ] Decide whether `DiffEditorManager` should stop here or split one level further by responsibility.
- [ ] Keep `src/index.base.ts` as orchestration only and avoid reintroducing editor update logic there.
- [ ] Audit `clearHighlighterCache()` semantics against the other shared highlighter state.
- [ ] Align `README.md`, `package.json`, `CHANGELOG.md`, and release workflow version story.
- [ ] Add at least one Playwright smoke job to CI.
- [ ] Add at least one real framework example (`React` or `Vue`) to match the package positioning.
- [ ] Verify `sideEffects: false` against the automatic worker hook behavior.
- [ ] Verify the build target / platform choices and document the reason if they stay as-is.
