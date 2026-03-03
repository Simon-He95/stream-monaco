# Streaming Demo (Vue 3 + Vite)

A minimal example showing streaming append and language switching using `stream-monaco`.

- Single editor with streaming `appendCode`
- Switch language mid-stream with `setLanguage`
- Optional: Diff editor streaming via `appendOriginal` / `appendModified`

## Quick start

```bash
pnpm i
pnpm -C examples/streaming-demo dev
```

Then open http://localhost:5173

Routes:

- `/` Streaming append demo
- `/diff` Diff streaming stress demo
- `/diff-ux` Diff UX demo (unchanged-region collapse/expand + hover hunk revert/stage)
