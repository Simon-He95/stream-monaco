# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.0.34] - 2026-04-15

- Added `updateThrottleMs` option (default 50ms) to throttle `updateCode` in addition to RAF-based coalescing. This reduces CPU usage in high-frequency streaming scenarios. Users can set to `0` to restore previous behavior (only RAF merging).
- Exposed `setUpdateThrottleMs(ms)` and `getUpdateThrottleMs()` on the `useMonaco` return value so the throttle can be adjusted at runtime.
- Exposed `minimalEditMaxChars` and `minimalEditMaxChangeRatio` options to control when the library falls back to full `setValue` instead of attempting minimal edits for large documents.
- Stabilized the `useMonaco()` create lifecycle so superseded creates are rejected cleanly and single-editor updates are replayed after creation commits.
- Split diff presentation helpers out of `DiffEditorManager` into focused modules for appearance, hunk behavior, unchanged-region DOM, and viewport logic.
- Expanded automated coverage for diff helpers, unchanged-region behavior, lifecycle cleanup, and minimal-edit option overrides.
- Added a React + Vite example app under `examples/react-demo`.
- Added a Playwright diff smoke job to CI.
- Aligned release metadata and workflow behavior around `v*` tags.
- `clearHighlighterCache()` now resets the shared Monaco/Shiki highlighter state in addition to clearing cached entries.

### Notes

- These changes are non-breaking. To preserve original behavior, set `updateThrottleMs: 0`.
