import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: [
      // eslint ignore globs here
      'examples/streaming-demo/src/shims-vue.d.ts',
      'src/worker/*.js',
      './test/',
      './scripts/',
    ],
  },
  {
    rules: {
      // overrides
    },
  },
)
