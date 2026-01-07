import type * as monaco from 'monaco-editor'
import type { Highlighter as _ShikiHighlighter, SpecialTheme, ThemeInput } from 'shiki'

export type ShikiHighlighter = _ShikiHighlighter | any

export type MonacoEditorInstance = monaco.editor.IStandaloneCodeEditor
export type MonacoDiffEditorInstance = monaco.editor.IStandaloneDiffEditor
export type MonacoTheme
  = | 'andromeeda'
    | 'aurora-x'
    | 'ayu-dark'
    | 'catppuccin-frappe'
    | 'catppuccin-latte'
    | 'catppuccin-macchiato'
    | 'catppuccin-mocha'
    | 'dark-plus'
    | 'dracula'
    | 'dracula-soft'
    | 'everforest-dark'
    | 'everforest-light'
    | 'github-dark'
    | 'github-dark-default'
    | 'github-dark-dimmed'
    | 'github-dark-high-contrast'
    | 'github-light'
    | 'github-light-default'
    | 'github-light-high-contrast'
    | 'gruvbox-dark-hard'
    | 'gruvbox-dark-medium'
    | 'gruvbox-dark-soft'
    | 'gruvbox-light-hard'
    | 'gruvbox-light-medium'
    | 'gruvbox-light-soft'
    | 'houston'
    | 'kanagawa-dragon'
    | 'kanagawa-lotus'
    | 'kanagawa-wave'
    | 'laserwave'
    | 'light-plus'
    | 'material-theme'
    | 'material-theme-darker'
    | 'material-theme-lighter'
    | 'material-theme-ocean'
    | 'material-theme-palenight'
    | 'min-dark'
    | 'min-light'
    | 'monokai'
    | 'night-owl'
    | 'nord'
    | 'one-dark-pro'
    | 'one-light'
    | 'plastic'
    | 'poimandres'
    | 'red'
    | 'rose-pine'
    | 'rose-pine-dawn'
    | 'rose-pine-moon'
    | 'slack-dark'
    | 'slack-ochin'
    | 'snazzy-light'
    | 'solarized-dark'
    | 'solarized-light'
    | 'synthwave-84'
    | 'tokyo-night'
    | 'vesper'
    | 'vitesse-black'
    | 'vitesse-dark'
    | 'vitesse-light'
    | ThemeInput
    | string
    | SpecialTheme
export type MonacoLanguage
  = | 'abap'
    | 'actionscript-3'
    | 'ada'
    | 'angular-html'
    | 'angular-ts'
    | 'apache'
    | 'apex'
    | 'apl'
    | 'applescript'
    | 'ara'
    | 'asciidoc'
    | 'asm'
    | 'astro'
    | 'awk'
    | 'ballerina'
    | 'bat'
    | 'beancount'
    | 'berry'
    | 'bibtex'
    | 'bicep'
    | 'blade'
    | 'bsl'
    | 'c'
    | 'cadence'
    | 'cairo'
    | 'clarity'
    | 'clojure'
    | 'cmake'
    | 'cobol'
    | 'codeowners'
    | 'codeql'
    | 'coffee'
    | 'common-lisp'
    | 'coq'
    | 'cpp'
    | 'crystal'
    | 'csharp'
    | 'css'
    | 'csv'
    | 'cue'
    | 'cypher'
    | 'd'
    | 'dart'
    | 'dax'
    | 'desktop'
    | 'diff'
    | 'docker'
    | 'dotenv'
    | 'dream-maker'
    | 'edge'
    | 'elixir'
    | 'elm'
    | 'emacs-lisp'
    | 'erb'
    | 'erlang'
    | 'fennel'
    | 'fish'
    | 'fluent'
    | 'fortran-fixed-form'
    | 'fortran-free-form'
    | 'fsharp'
    | 'gdresource'
    | 'gdscript'
    | 'gdshader'
    | 'genie'
    | 'gherkin'
    | 'git-commit'
    | 'git-rebase'
    | 'gleam'
    | 'glimmer-js'
    | 'glimmer-ts'
    | 'glsl'
    | 'gnuplot'
    | 'go'
    | 'graphql'
    | 'groovy'
    | 'hack'
    | 'haml'
    | 'handlebars'
    | 'haskell'
    | 'haxe'
    | 'hcl'
    | 'hjson'
    | 'hlsl'
    | 'html'
    | 'html-derivative'
    | 'http'
    | 'hxml'
    | 'hy'
    | 'imba'
    | 'ini'
    | 'java'
    | 'javascript'
    | 'jinja'
    | 'jison'
    | 'json'
    | 'json5'
    | 'jsonc'
    | 'jsonl'
    | 'jsonnet'
    | 'jssm'
    | 'jsx'
    | 'julia'
    | 'kotlin'
    | 'kusto'
    | 'latex'
    | 'lean'
    | 'less'
    | 'liquid'
    | 'llvm'
    | 'log'
    | 'logo'
    | 'lua'
    | 'luau'
    | 'make'
    | 'markdown'
    | 'marko'
    | 'matlab'
    | 'mdc'
    | 'mdx'
    | 'mermaid'
    | 'mipsasm'
    | 'mojo'
    | 'move'
    | 'narrat'
    | 'nextflow'
    | 'nginx'
    | 'nim'
    | 'nix'
    | 'nushell'
    | 'objective-c'
    | 'objective-cpp'
    | 'ocaml'
    | 'pascal'
    | 'perl'
    | 'php'
    | 'plsql'
    | 'po'
    | 'polar'
    | 'postcss'
    | 'powerquery'
    | 'powershell'
    | 'prisma'
    | 'prolog'
    | 'proto'
    | 'pug'
    | 'puppet'
    | 'purescript'
    | 'python'
    | 'qml'
    | 'qmldir'
    | 'qss'
    | 'r'
    | 'racket'
    | 'raku'
    | 'razor'
    | 'reg'
    | 'regexp'
    | 'rel'
    | 'riscv'
    | 'rst'
    | 'ruby'
    | 'rust'
    | 'sas'
    | 'sass'
    | 'scala'
    | 'scheme'
    | 'scss'
    | 'sdbl'
    | 'shaderlab'
    | 'shellscript'
    | 'shellsession'
    | 'smalltalk'
    | 'solidity'
    | 'soy'
    | 'sparql'
    | 'splunk'
    | 'sql'
    | 'ssh-config'
    | 'stata'
    | 'stylus'
    | 'svelte'
    | 'swift'
    | 'system-verilog'
    | 'systemd'
    | 'talonscript'
    | 'tasl'
    | 'tcl'
    | 'templ'
    | 'terraform'
    | 'tex'
    | 'toml'
    | 'ts-tags'
    | 'tsv'
    | 'tsx'
    | 'turtle'
    | 'twig'
    | 'typescript'
    | 'typespec'
    | 'typst'
    | 'v'
    | 'vala'
    | 'vb'
    | 'verilog'
    | 'vhdl'
    | 'viml'
    | 'vue'
    | 'vue-html'
    | 'vyper'
    | 'wasm'
    | 'wenyan'
    | 'wgsl'
    | 'wikitext'
    | 'wit'
    | 'wolfram'
    | 'xml'
    | 'xsl'
    | 'yaml'
    | 'zenscript'
    | 'zig'
    | string

export interface MonacoOptions
  extends monaco.editor.IStandaloneEditorConstructionOptions {
  MAX_HEIGHT?: number | string
  readOnly?: boolean
  themes?: MonacoTheme[]
  languages?: MonacoLanguage[]
  theme?: string
  isCleanOnBeforeCreate?: boolean
  /**
   * 控制更新时的自动滚动行为：当为 true 时，如果当前接近底部则在新增内容后自动滚动到底部；
   * 当为 false 时，将完全禁用自动滚动。
   * 默认 true。
   */
  autoScrollOnUpdate?: boolean
  /**
   * 编辑器创建时是否默认启用自动滚动。用户一旦滚离底部将自动暂停，回到底部附近再恢复。
   * 默认 true（保持原有行为）。
   */
  autoScrollInitial?: boolean
  /**
   * 触发“接近底部”的绝对像素阈值。如果设置，将与 autoScrollThresholdLines 共同取最大值。
   * 默认 32。
   */
  autoScrollThresholdPx?: number
  /**
   * 触发“接近底部”的相对行数阈值（以当前行高计算）。如果设置，将与 autoScrollThresholdPx 共同取最大值。
   * 默认 2 行。
   */
  autoScrollThresholdLines?: number
  /**
   * 是否启用 Diff 编辑器 modified 侧的自动滚动逻辑。
   * 当为 false 时，updateDiff/appendModified 等不会触发自动滚动。
   * 默认 true（与单编辑器体验保持一致）。
   */
  diffAutoScroll?: boolean
  /**
   * Debounce time (ms) to coalesce multiple reveal requests into a single
   * reveal. Useful for streaming/append scenarios. Default: 75
   */
  revealDebounceMs?: number
  /**
   * How to reveal target line when auto-scrolling.
   * - 'bottom' : revealLine (closest to bottom)
   * - 'centerIfOutside' : revealLineInCenterIfOutsideViewport (default)
   * - 'center' : revealLineInCenter
   */
  revealStrategy?: 'bottom' | 'centerIfOutside' | 'center'
  /**
   * If set to a positive number (ms), append/streaming scenarios will delay a final
   * "scroll to bottom" until this idle time has passed since the last append. Useful
   * to batch many small appends and then perform one final jump to bottom. Default: undefined (disabled).
   */
  revealBatchOnIdleMs?: number
  /**
   * Time window (ms) used to throttle `updateCode` calls in addition to RAF batching.
   * - 0 means only RAF-based coalescing (no extra time throttling).
   * - Default (library): 50
   */
  updateThrottleMs?: number

  /**
   * Time window (ms) used to throttle diff streaming updates in addition to RAF batching.
   * This affects `appendOriginal`/`appendModified` and the fast-path append branches of `updateDiff`.
   *
   * Why: Monaco's diff computation is async and cancels/restarts when models change.
   * If you apply edits every frame (or per token), the diff may only finish once
   * streaming stops, so the highlights appear "at the end".
   *
   * - 0 means only RAF-based coalescing (more responsive, but can starve diff computation).
   * - Default (library): 50
   */
  diffUpdateThrottleMs?: number
  /**
   * When attempting the "minimal edit" algorithm, if prev.length + next.length
   * exceeds this number the library will fall back to full `setValue` to avoid
   * expensive diff computation on very large documents.
   */
  minimalEditMaxChars?: number
  /**
   * When the relative change ratio (|new-prev|/maxLen) exceeds this value the
   * library will fall back to full `setValue` instead of attempting minimal edit.
   */
  minimalEditMaxChangeRatio?: number
  // 添加在编辑器创建之前的钩子
  onBeforeCreate?: (
    monaco: typeof import('monaco-editor'),
  ) => monaco.IDisposable[]
  /**
   * Optional callback that is invoked after a theme change has been applied.
   * This callback will be awaited when possible so callers can track completion
   * of theme application. It receives the name of the applied theme.
   */
  onThemeChange?: (theme: MonacoTheme) => void | Promise<void>
}

// Convenience enum for consumers who prefer a TypeScript constant instead of strings
export enum RevealStrategy {
  Bottom = 'bottom',
  CenterIfOutside = 'centerIfOutside',
  Center = 'center',
}
