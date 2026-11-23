/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Comments are stripped, so a commented-out declaration cannot count as a definition.
const css = readFileSync(join(import.meta.dirname, 'theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

// The page's own rules, comments stripped the same way (T-018).
const appCss = readFileSync(join(import.meta.dirname, '..', 'App.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

/** The text between the braces of the first block that opens a line with `opener` (a selector or an at-rule). */
function blockBody(source: string, opener: string): string {
  const escaped = opener.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = new RegExp(`^\\s*${escaped} \\{`, 'm').exec(source)
  if (start === null) return ''
  let depth = 0
  for (let i = start.index + start[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(start.index + start[0].length, i)
  }
  return ''
}

// property -> value for the declarations of one block body, whitespace folded
const declared = (body: string) =>
  new Map(
    [...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map(
      (m) => [m[1] ?? '', (m[2] ?? '').trim().replace(/\s+/g, ' ')] as const,
    ),
  )

// The declarations of the first `:root` block, and of the `:root` block inside the dark media query.
const light = /^:root \{([^}]*)\}/m.exec(css)?.[1] ?? ''
const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? ''

// The contract: the colour token names the feature UI builds on.
const contract = [
  '--color-accent',
  '--color-bg',
  '--color-danger',
  '--color-success',
  '--color-surface',
  '--color-text',
  '--color-text-muted',
  '--color-warning',
]

// name -> value for every `--color-*` declaration in a block
const colors = (block: string) =>
  new Map(
    [...block.matchAll(/(--color-[a-z-]+):\s*([^;]*);/g)].map(
      (m) => [m[1] ?? '', (m[2] ?? '').trim()] as const,
    ),
  )

describe('theme.css', () => {
  it('T006-UI the page-chosen dark theme, :root[data-theme="dark"], has exactly the system dark values', () => {
    const chosen = /^:root\[data-theme='dark'\] \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    const tokens = (block: string) =>
      [...block.matchAll(/(--[a-z0-9-]+):\s*([^;]*);/g)].map((m) => `${m[1]}: ${m[2]}`).sort()

    expect(tokens(chosen)).toEqual(tokens(dark))
    expect([...colors(chosen).keys()].sort()).toEqual(contract)
    expect(chosen).toMatch(/color-scheme:\s*dark;/)
  })

  it('T002-S3 defines every --color-* token, with a value, in the light block and in the dark block', () => {
    for (const block of [light, dark]) {
      const declared = colors(block)

      expect([...declared.keys()].sort()).toEqual(contract)
      for (const name of contract) {
        expect(declared.get(name)).toMatch(/\S/)
      }
    }
  })
})

describe('App.css (T-018)', () => {
  const systemDark = blockBody(appCss, '@media (prefers-color-scheme: dark)')

  it('T018-1 on a narrow screen the header stacks, so the pill always has its own row', () => {
    const header = declared(
      blockBody(blockBody(appCss, '@media (max-width: 36rem)'), '.app-header'),
    )

    expect(header.get('flex-direction')).toBe('column')
    expect(header.get('align-items')).toBe('flex-start')
  })

  it('T018-2 the pill row keeps the height of its tallest content, so Offline and its button do not grow the header', () => {
    const connection = declared(blockBody(appCss, '.connection'))

    expect(connection.get('min-height')).toBe('2.5rem')
  })

  it('T018-3 the composer has a 1px edge that is clear in light and a hairline in both dark forms', () => {
    const composer = declared(blockBody(appCss, '.composer'))
    const system = declared(blockBody(systemDark, '.composer'))
    const chosen = declared(blockBody(appCss, ":root[data-theme='dark'] .composer"))

    expect(composer.get('border')).toBe('1px solid transparent')
    expect(system.get('border-color')).toBe(
      'color-mix(in srgb, var(--color-text-muted) 20%, transparent)',
    )
    expect(chosen).toEqual(system)
  })

  it('T018-4 a disabled button in dark is a ghost with muted text and edge, in both dark forms', () => {
    const system = declared(blockBody(systemDark, '.button:disabled'))
    const chosen = declared(blockBody(appCss, ":root[data-theme='dark'] .button:disabled"))

    expect(system.get('background')).toBe('transparent')
    expect(system.get('color')).toBe('var(--color-text-muted)')
    expect(system.get('border-color')).toBe('var(--color-text-muted)')
    expect(system.get('opacity')).toBe('1')
    expect(chosen).toEqual(system)
  })

  it('T018-4 the light disabled button keeps its faded look', () => {
    const disabled = declared(blockBody(appCss, '.button:disabled'))

    expect(disabled.get('opacity')).toBe('0.45')
    expect(disabled.get('cursor')).toBe('not-allowed')
  })
})
