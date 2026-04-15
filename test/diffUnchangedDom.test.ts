import { describe, expect, it } from 'vitest'

import {
  activateDiffUnchangedExpandAction,
  bindDiffUnchangedRevealButtonAction,
  collectDiffUnchangedViewZoneIds,
  findDiffUnchangedActivationAction,
  findDiffUnchangedExpandAction,
  resolveDiffUnchangedWheelScrollTarget,
  resolveDiffUnchangedViewZoneHeight,
  shouldHandleDiffUnchangedCenterClick,
  shouldHandleDiffUnchangedWheel,
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

  it('handles only primary center clicks that are not already on actions', () => {
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
        shouldHandleDiffUnchangedCenterClick({
          button: 0,
          target: new HTMLElementMock(null) as any,
        } as any),
      ).toBe(true)
      expect(
        shouldHandleDiffUnchangedCenterClick({
          button: 1,
          target: new HTMLElementMock(null) as any,
        } as any),
      ).toBe(false)
      expect(
        shouldHandleDiffUnchangedCenterClick({
          button: 0,
          target: new HTMLElementMock({}) as any,
        } as any),
      ).toBe(false)
    }
    finally {
      globalThis.HTMLElement = previousHTMLElement
    }
  })

  it('resolves unchanged wheel handling and scroll targets', () => {
    expect(shouldHandleDiffUnchangedWheel({ deltaX: 0, deltaY: 0.4 } as any)).toBe(false)
    expect(shouldHandleDiffUnchangedWheel({ deltaX: 0, deltaY: 2 } as any)).toBe(true)

    expect(
      resolveDiffUnchangedWheelScrollTarget(10, 20, {
        deltaX: 5,
        deltaY: 7,
      } as any),
    ).toEqual({
      targetScrollTop: 17,
      targetScrollLeft: 25,
      syncHorizontal: true,
    })
  })

  it('binds reveal button activation only when a handle exists', () => {
    const events: string[] = []
    const button = {
      onclick: null as null | ((event: any) => void),
    }
    const handle = { id: 'top' }

    bindDiffUnchangedRevealButtonAction(
      button as any,
      handle as any,
      (nextHandle) => {
        events.push((nextHandle as any).id)
      },
    )

    button.onclick?.({
      preventDefault() {
        events.push('prevent')
      },
      stopPropagation() {
        events.push('stop')
      },
    })

    expect(events).toEqual(['prevent', 'stop', 'top'])

    bindDiffUnchangedRevealButtonAction(button as any, null, () => {
      events.push('unexpected')
    })
    expect(button.onclick).toBeNull()
  })

  it('activates the expand action from a center root when present', () => {
    const events: string[] = []
    const root = {
      querySelector(selector: string) {
        if (selector !== 'a')
          return null
        return {
          click() {
            events.push('click')
          },
        }
      },
    }

    expect(
      activateDiffUnchangedExpandAction(root as any, () => {
        events.push('before')
      }),
    ).toBe(true)
    expect(events).toEqual(['before', 'click'])
    expect(
      activateDiffUnchangedExpandAction({ querySelector: () => null } as any),
    ).toBe(false)
  })
})
