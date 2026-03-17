# Diff Integration Guide

This guide focuses on integrating the `stream-monaco` diff editor, which options to pass, and which TypeScript types are available out of the box.

## 1. Minimal setup

```ts
import { useMonaco } from 'stream-monaco'

const container = document.getElementById('diff')!

const { createDiffEditor, updateDiff, cleanupEditor } = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript', 'javascript', 'json'],
  readOnly: true,
  MAX_HEIGHT: 560,
})

await createDiffEditor(
  container,
  'export const a = 1\n',
  'export const a = 2\n',
  'typescript',
)

updateDiff('export const a = 1\n', 'export const a = 3\n', 'typescript')

cleanupEditor()
```

The mount/update/unmount pattern is the same in Vue, React, Svelte, Solid, and vanilla JS:

- call `createDiffEditor(...)` on mount
- call `updateDiff(...)` / `updateOriginal(...)` / `updateModified(...)` when content changes
- call `cleanupEditor()` on unmount

## 2. Which options to pass

All options are passed through `useMonaco(options)`.

### Core options

```ts
const monaco = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript', 'javascript'],
  theme: 'github-light',
  readOnly: true,
  MAX_HEIGHT: 560,
})
```

Most common:

- `themes`: available themes, ideally one dark and one light
- `languages`: languages to register
- `theme`: initial theme
- `readOnly`: usually `true` for review/preview diffs
- `MAX_HEIGHT`: max editor height

### stream-monaco diff UX options

```ts
const monaco = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript'],
  readOnly: true,

  diffHideUnchangedRegions: {
    enabled: true,
    contextLineCount: 3,
    minimumLineCount: 3,
    revealLineCount: 5,
  },
  diffLineStyle: 'background',
  diffAppearance: 'auto',
  diffUnchangedRegionStyle: 'line-info',
  diffHunkActionsOnHover: true,
  diffHunkHoverHideDelayMs: 160,
  diffUpdateThrottleMs: 50,
  revealDebounceMs: 75,
})
```

What they do:

- `diffHideUnchangedRegions`
  Controls unchanged-region folding. Accepts `true`, `false`, or Monaco's native `hideUnchangedRegions` object.
- `diffLineStyle`
  Visual emphasis for changed lines.
  - `background`: richer filled blocks
  - `bar`: subtler review-style leading bars
- `diffAppearance`
  Controls diff chrome appearance.
  - `auto`: infer from active Monaco theme
  - `light`: force light shell
  - `dark`: force dark shell
- `diffUnchangedRegionStyle`
  Controls collapsed unchanged-region rendering.
  - `line-info`: `71 unmodified lines` with line-number-width reveal buttons in a compact 32px collapsed row
  - `line-info-basic`: `71 unmodified lines` with the wider legacy reveal rail in a compact 32px row
  - `metadata`: `@@ -59,9 +59,11 @@` in a compact 32px row; lines below the collapsed region reflow to close the extra whitespace
  - `simple`: gray placeholder bar in a tighter 28px row
- `diffHunkActionsOnHover`
  Enables `Revert / Stage` on hovered hunks
- `diffHunkHoverHideDelayMs`
  Hide delay for hunk hover actions
- `diffUpdateThrottleMs`
  Diff streaming throttle. Default is `50`.
  When `diffHideUnchangedRegions` is enabled, unchanged-region folding is deferred until streaming goes idle so the diff does not collapse while content is still streaming in.
- `revealDebounceMs`
  Debounce for reveal/auto-scroll behavior

### Native Monaco diff options

`MonacoOptions` now includes both:

- `monaco.editor.IStandaloneEditorConstructionOptions`
- `monaco.editor.IDiffEditorConstructionOptions`

So you can also pass native Monaco diff options directly:

```ts
useMonaco({
  renderSideBySide: true,
  enableSplitViewResizing: true,
  ignoreTrimWhitespace: false,
  originalEditable: false,
})
```

To switch between side-by-side and inline at runtime:

```ts
const diff = monaco.getDiffEditorView()
diff?.updateOptions({ renderSideBySide: false })
```

## 3. Runtime methods

```ts
const {
  createDiffEditor,
  updateDiff,
  updateOriginal,
  updateModified,
  appendOriginal,
  appendModified,
  setDiffModels,
  setTheme,
  refreshDiffPresentation,
  getDiffEditorView,
  getDiffModels,
  getCode,
} = useMonaco()
```

Most useful diff methods:

- `createDiffEditor(container, original, modified, language)`
- `updateDiff(original, modified, language?)`
- `updateOriginal(code, language?)`
- `updateModified(code, language?)`
- `appendOriginal(text, language?)`
- `appendModified(text, language?)`
- `await setDiffModels({ original, modified }, options?)`
- `setTheme(theme, force?)`
- `refreshDiffPresentation()`
- `getDiffEditorView()`
- `getDiffModels()`
- `getCode()`

In diff mode, `getCode()` returns:

```ts
{
  original: string
  modified: string
}
```

### In-place theme / presentation switches

If you are only changing theme, appearance, line style, or unchanged-region style, prefer the in-place runtime methods instead of remounting the diff editor:

```ts
await monaco.setTheme('github-dark')
monaco.refreshDiffPresentation()
```

This keeps the existing diff shell, scroll position, and unchanged-region overlay alive while recomputing the presentation layer.

Theme and appearance switches should stay visually stable. When you switch between unchanged-region styles with different collapsed heights, such as `metadata` to `simple`, the shell stays mounted but Monaco will reflow the lines below those collapsed regions to match the new height.

### Whole-model swaps without remounting

If your app needs to replace the entire `original/modified` model pair, prefer `await setDiffModels(...)` over calling `diffEditor.setModel(...)` yourself:

```ts
const monacoApi = useMonaco()

const originalModel = monacoApi
  .getMonacoInstance()
  .editor.createModel(leftText, 'typescript')
const modifiedModel = monacoApi
  .getMonacoInstance()
  .editor.createModel(rightText, 'typescript')

await monacoApi.setDiffModels(
  {
    original: originalModel,
    modified: modifiedModel,
  },
  {
    codeLanguage: 'typescript',
  },
)
```

Why this is better than raw `diffEditor.setModel(...)`:

- the library can precompute Monaco's diff view model before the visible swap, so same-content transitions avoid the first-frame scroll jump
- if the new models contain the same text, `stream-monaco` automatically takes the low-jitter path and preserves view state by default
- unchanged-region state and diff chrome are refreshed together
- internally-owned models are disposed safely, while externally-supplied models are left under your control

Options:

- `codeLanguage`: normalize both models to the target language before swapping
- `preserveViewState`: force preserving the diff view state even when content changed

## 4. Hunk action callback

If you want to intercept `Revert / Stage`, use `onDiffHunkAction`:

```ts
useMonaco({
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    await saveHunk(ctx)
    return false
  },
})
```

Return semantics:

- `false`: skip built-in edit behavior, fully controlled by your app
- `true` or `undefined`: continue built-in behavior

The callback context type is `DiffHunkActionContext`.

## 5. Binding to real Git (`revert`, `stage`, `stash`)

`stream-monaco` does not talk to Git by default. The built-in hover actions only edit the in-memory Monaco models.

Important distinctions:

- Hover `Revert` is hunk-level undo. It is not `git revert <commit>`, because `git revert` works at commit granularity.
- Hover `Stage` is closest to `git add -p` / `git apply --cached`.
- If you want a stash workflow, treat `onDiffHunkAction` as a patch-intent callback and hand the selected half-hunk to a backend stash API or patch queue.

The practical pattern is:

1. Intercept `onDiffHunkAction`.
2. Send `action`, `side`, `lineChange`, `original`, and `modified` to your backend.
3. On the backend, compute the target file contents for that half-hunk.
4. Turn the current content -> target content delta into a unified patch for that file.
5. Apply it to Git:
   - working tree revert: `git apply --recount -`
   - index stage: `git apply --cached --recount -`
   - custom stash: store the same patch in your own stash service, or wrap a server-side Git stash flow
6. Return the refreshed `original` / `modified` pair to the browser and call `updateDiff(...)` or `setDiffModels(...)`.

Frontend example:

```ts
const monaco = useMonaco({
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    const response = await fetch('/api/git/hunks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath,
        filePath,
        action: ctx.action,
        side: ctx.side,
        range: ctx.lineChange,
        original: ctx.originalModel.getValue(),
        modified: ctx.modifiedModel.getValue(),
      }),
    })

    const next = await response.json()
    monaco.updateDiff(next.original, next.modified, language)

    // Skip the built-in local-only model edit because Git already applied it.
    return false
  },
})
```

Common variant: backend returns the refreshed file pair, and the client updates the diff in-place with `updateDiff(...)`.

This is usually the simplest integration shape when your server already knows the post-apply file contents for both sides:

```ts
const monaco = useMonaco({
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    const response = await fetch('/api/git/hunks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: ctx.action,
        side: ctx.side,
        range: ctx.lineChange,
        original: ctx.originalModel.getValue(),
        modified: ctx.modifiedModel.getValue(),
      }),
    })

    const next = await response.json()

    // The server returns the refreshed left/right file contents after Git apply.
    monaco.updateDiff(next.original, next.modified, language)
    return false
  },
})
```

When to prefer this:

- your backend already computes the full refreshed `original` / `modified`
- you want to keep the current diff editor instance and just refresh its content
- you do not need to swap to externally-owned Monaco models

If the backend gives you brand-new Monaco models instead of plain strings, use `setDiffModels(...)` instead.

Backend mapping to keep in mind:

- `revert + lower`: remove the modified-side lines from the working tree
- `revert + upper`: restore the original-side lines into the working tree
- `stage + lower`: copy the modified-side lines into the index
- `stage + upper`: remove the original-side lines from the index

For replace hunks that have both upper and lower halves, do not think in terms of a single Git command name. Instead, compute the next desired file text for the selected half-hunk, build a patch for that exact delta, then apply it to the worktree or index.

If your product wants a real "stash this hunk" action, the safest route is usually a backend "saved patch" queue. `git stash push --patch` exists, but it is interactive and repo-scoped, so browser-driven review tools typically wrap it server-side or implement their own stash layer around patch files.

Reference validations in this repo:

- `pnpm run validate:diff-hunk-actions`: verifies the built-in local Revert/Stage semantics
- `pnpm run validate:diff-hunk-custom-flow`: verifies async custom intercept flow where user code mutates the models directly
- `pnpm run validate:diff-hunk-update-diff-flow`: verifies async custom intercept flow where the server returns refreshed file contents and the UI calls `updateDiff(...)`

## 6. TypeScript completeness

The public TS surface for diff integration is now fairly complete. These types are exported:

- `MonacoOptions`
- `UseMonacoReturn`
- `MonacoTheme`
- `MonacoLanguage`
- `MonacoEditorInstance`
- `MonacoDiffEditorInstance`
- `DiffHideUnchangedRegions`
- `DiffLineStyle`
- `DiffAppearance`
- `DiffUnchangedRegionStyle`
- `DiffModels`
- `DiffModelPair`
- `DiffModelTransitionOptions`
- `DiffCodeValue`
- `MonacoCodeValue`
- `DiffHunkActionContext`

### What is covered

- `useMonaco(options)` now has an explicit return type: `UseMonacoReturn`
- custom diff UX options have dedicated union types
- `MonacoOptions` covers both single-editor and native diff-editor construction options
- return values such as `getCode()` and `getDiffModels()` have named exported types

### Practical answer

If your question is "do I still need to write custom declarations for diff integration?", the answer is now basically no.

More directly:

- custom diff options: typed
- `useMonaco()` return value: typed
- native Monaco diff option pass-through: typed

## 6. Recommended typed setup

```ts
import type {
  DiffAppearance,
  DiffUnchangedRegionStyle,
  MonacoOptions,
  UseMonacoReturn,
} from 'stream-monaco'

const options: MonacoOptions = {
  themes: ['github-dark', 'github-light'],
  languages: ['typescript'],
  readOnly: true,
  diffAppearance: 'auto',
  diffLineStyle: 'background',
  diffUnchangedRegionStyle: 'line-info',
  diffHideUnchangedRegions: true,
  diffHunkActionsOnHover: true,
}

const monacoApi: UseMonacoReturn = useMonaco(options)
```

This gives the cleanest IDE autocomplete and keeps later UX upgrades easy to maintain.
