/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Comments are stripped, so a commented-out declaration cannot count as a definition.
const css = readFileSync(join(import.meta.dirname, 'theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
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
