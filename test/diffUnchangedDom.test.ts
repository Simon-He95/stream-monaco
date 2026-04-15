import { describe, expect, it } from 'vitest'

import {
  collectDiffUnchangedViewZoneIds,
  findDiffUnchangedActivationAction,
  findDiffUnchangedExpandAction,
  resolveDiffUnchangedViewZoneHeight,
  shouldIgnoreDiffUnchangedCenterClickTarget,
} from '../src/core/diffUnchangedDom'

describe('diffUnchangedDom helpers', () => {
  it('resolves unchanged view-zone heights from style', () => {
    expect(resolveDiffUnchangedViewZoneHeight('simple')).toBe(28)
    expect(resolveDiffUnchangedViewZoneHeight('line-info')).toBe(32)
    expect(resolveDiffUnchangedViewZoneHeight('line-info-basic')).toBe(32)
    expect(resolveDiffUnchangedViewZoneHeight('metadata')).toBe(32)
  })

  it('collects visible diff unchanged view-zone ids that align with widgets', () => {
    const editorRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.diff-hidden-lines-widget') {
          return [
            { style: { top: '20' } },
            { style: { top: '-100001' } },
          ]
        }

        if (
          selector
          === '.view-zones > div[monaco-view-zone][monaco-visible-view-zone="true"]'
        ) {
          return [
            {
              style: { top: '120', height: '32' },
              getAttribute(name: string) {
                return name === 'monaco-view-zone' ? 'zone-a' : null
              },
            },
            {
              style: { top: '120', height: '0' },
              getAttribute(name: string) {
                return name === 'monaco-view-zone' ? 'zone-b' : null
              },
            },
            {
              style: { top: '160', height: '32' },
              getAttribute(name: string) {
                return name === 'monaco-view-zone' ? 'zone-c' : null
              },
            },
          ]
        }

        return []
      },
    }

    expect(
      collectDiffUnchangedViewZoneIds(editorRoot as any, 100),
    ).toEqual(['zone-a'])
  })

  it('finds expand and activation actions from unchanged widgets', () => {
    const expandAction = { kind: 'expand' }
    const fallbackAction = { kind: 'fallback' }

    const centerNode = {
      querySelector(selector: string) {
        return selector === 'a' ? expandAction : null
      },
    }
    const primaryNode = {
      querySelector(selector: string) {
        return selector === 'a, button' ? fallbackAction : null
      },
    }

    expect(findDiffUnchangedExpandAction(centerNode as any)).toBe(expandAction)
    expect(
      findDiffUnchangedActivationAction(null, primaryNode as any),
    ).toBe(fallbackAction)
  })

  it('ignores center clicks that originate from links or breadcrumbs', () => {
    class HTMLElementMock {
      constructor(private readonly result: unknown) {}

      closest() {
        return this.result
      }
    }

    const previousHTMLElement = globalThis.HTMLElement
    globalThis.HTMLElement = HTMLElementMock as any

    try {
      expect(
        shouldIgnoreDiffUnchangedCenterClickTarget(
          new HTMLElementMock({}) as any,
        ),
      ).toBe(true)
      expect(
        shouldIgnoreDiffUnchangedCenterClickTarget(
          new HTMLElementMock(null) as any,
        ),
      ).toBe(false)
      expect(shouldIgnoreDiffUnchangedCenterClickTarget(null)).toBe(false)
    }
    finally {
      globalThis.HTMLElement = previousHTMLElement
    }
  })
})
