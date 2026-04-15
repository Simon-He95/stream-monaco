import { defineConfig } from 'tsdown'

export default defineConfig({
  target: 'node14',
  entry: ['src/index.ts', 'src/index.legacy.ts'],
  format: ['cjs', 'esm'],
  clean: true,
  dts: true,
  // Keep the current Node-oriented transform path for the published build.
  // The package is consumed in browsers after app bundling, but this setting
  // keeps the generated CJS/ESM worker URL handling stable; CI validates the
  // browser-facing paths through the example builds and Playwright smoke test.
  platform: 'node',
})
