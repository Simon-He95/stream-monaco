import { useEffect, useRef, useState } from 'react'
import { preloadMonacoWorkers, useMonaco } from 'stream-monaco'

type DemoLanguage = 'typescript' | 'markdown'
type DemoTheme = 'vitesse-dark' | 'vitesse-light'

const initialCodeByLanguage: Record<DemoLanguage, string> = {
  typescript: [
    'type User = {',
    '  id: string',
    '  role: "admin" | "member"',
    '}',
    '',
    'export function formatUser(user: User) {',
    String.raw`  return \`\${user.id}:\${user.role}\``,
    '}',
  ].join('\n'),
  markdown: [
    '# stream-monaco',
    '',
    '- React host example',
    '- Monaco editor created from a component',
    '- Streaming updates via `appendCode()`',
  ].join('\n'),
}

const streamTargetByLanguage: Record<DemoLanguage, string> = {
  typescript: [
    '',
    'export async function loadUsers(): Promise<User[]> {',
    '  return [',
    '    { id: "u_1", role: "admin" },',
    '    { id: "u_2", role: "member" },',
    '  ]',
    '}',
    '',
    'for (const user of await loadUsers()) {',
    '  console.log(formatUser(user))',
    '}',
  ].join('\n'),
  markdown: [
    '',
    '## Streaming Notes',
    '',
    '1. The editor is mounted once.',
    '2. Theme and language swap in place.',
    '3. Chunks append over time to mimic token streaming.',
    '',
    '```ts',
    'appendCode(chunk, language)',
    '```',
  ].join('\n'),
}

preloadMonacoWorkers()

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const codeRef = useRef(initialCodeByLanguage.typescript)
  const apiRef = useRef<ReturnType<typeof useMonaco> | null>(null)

  if (!apiRef.current) {
    apiRef.current = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['typescript', 'markdown', 'json'],
      readOnly: false,
      MAX_HEIGHT: 460,
      wordWrap: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    })
  }

  const [language, setLanguage] = useState<DemoLanguage>('typescript')
  const [theme, setTheme] = useState<DemoTheme>('vitesse-dark')
  const [streaming, setStreaming] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('Ready')

  useEffect(() => {
    const api = apiRef.current
    if (!api)
      return

    async function mount() {
      if (!containerRef.current)
        return
      await api.createEditor(
        containerRef.current,
        codeRef.current,
        language,
      )
    }

    void mount()

    return () => {
      if (timerRef.current != null)
        window.clearInterval(timerRef.current)
      api.cleanupEditor()
    }
  }, [])

  function stopStreaming() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setStreaming(false)
  }

  function applyExample(nextLanguage: DemoLanguage) {
    stopStreaming()
    const nextCode = initialCodeByLanguage[nextLanguage]
    codeRef.current = nextCode
    setLanguage(nextLanguage)
    apiRef.current?.updateCode(nextCode, nextLanguage)
    apiRef.current?.setLanguage(nextLanguage)
    setProgress(0)
    setStatus(`Loaded ${nextLanguage} example`)
  }

  function applyTheme(nextTheme: DemoTheme) {
    setTheme(nextTheme)
    void apiRef.current?.setTheme(nextTheme)
  }

  function resetEditor() {
    stopStreaming()
    const nextCode = initialCodeByLanguage[language]
    codeRef.current = nextCode
    apiRef.current?.updateCode(nextCode, language)
    setProgress(0)
    setStatus('Reset to initial example')
  }

  function startStreaming() {
    stopStreaming()
    const remaining = streamTargetByLanguage[language]
    const chunks = remaining.match(/[\s\S]{1,42}/g) ?? [remaining]

    setStreaming(true)
    setStatus('Streaming...')
    let index = 0

    timerRef.current = window.setInterval(() => {
      const chunk = chunks[index]
      if (!chunk) {
        stopStreaming()
        setProgress(100)
        setStatus('Streaming complete')
        return
      }

      apiRef.current?.appendCode(chunk, language)
      codeRef.current += chunk
      index += 1
      setProgress(Math.round((index / chunks.length) * 100))
    }, 80)
  }

  return (
    <div className="page-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">React Example</p>
          <h1>stream-monaco in a real React app</h1>
          <p className="lede">
            This example mounts Monaco once, swaps theme and language in place,
            and streams content with
            {' '}
            <code>appendCode()</code>
            .
          </p>
        </div>

        <div className="control-grid">
          <div className="control-group">
            <span>Language</span>
            <div className="button-row">
              <button
                className={language === 'typescript' ? 'active' : ''}
                onClick={() => applyExample('typescript')}
                type="button"
              >
                TypeScript
              </button>
              <button
                className={language === 'markdown' ? 'active' : ''}
                onClick={() => applyExample('markdown')}
                type="button"
              >
                Markdown
              </button>
            </div>
          </div>

          <div className="control-group">
            <span>Theme</span>
            <div className="button-row">
              <button
                className={theme === 'vitesse-dark' ? 'active' : ''}
                onClick={() => applyTheme('vitesse-dark')}
                type="button"
              >
                Dark
              </button>
              <button
                className={theme === 'vitesse-light' ? 'active' : ''}
                onClick={() => applyTheme('vitesse-light')}
                type="button"
              >
                Light
              </button>
            </div>
          </div>

          <div className="control-group">
            <span>Actions</span>
            <div className="button-row">
              <button onClick={startStreaming} type="button">
                Start stream
              </button>
              <button onClick={resetEditor} type="button">
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="status-row">
          <span>{status}</span>
          <span>
            {progress}
            %
          </span>
          <span>{streaming ? 'Streaming' : 'Idle'}</span>
        </div>
      </section>

      <section className="editor-card">
        <div ref={containerRef} className="editor-frame" />
      </section>
    </div>
  )
}
