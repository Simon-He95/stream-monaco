# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Added `updateThrottleMs` option (default 50ms) to throttle `updateCode` in addition to RAF-based coalescing. This reduces CPU usage in high-frequency streaming scenarios. Users can set to `0` to restore previous behavior (only RAF merging).
- Exposed `setUpdateThrottleMs(ms)` and `getUpdateThrottleMs()` on the `useMonaco` return value so the throttle can be adjusted at runtime.
- Exposed `minimalEditMaxChars` and `minimalEditMaxChangeRatio` options to control when the library falls back to full `setValue` instead of attempting minimal edits for large documents.
- Added a lightweight Node benchmark (`scripts/stream-benchmark.mjs`) and a browser-focused test harness planned for future work.
- Added unit tests for throttle behavior.

### Notes

- These changes are non-breaking. To preserve original behavior, set `updateThrottleMs: 0`.
