/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CREATED_AT, E, msg } from '../test/fixtures'
import { MessageList } from './MessageList'

const EMPTY = 'No messages yet. Send the first one.'
const LOADING = 'Loading messages…'

describe('MessageList', () => {
  it('T006-S2 shows the empty copy only when loaded, empty, and no reload is pending or failed', () => {
    const { rerender } = render(<MessageList list="ready" reload="idle" messages={[]} />)
    expect(screen.getByText(EMPTY)).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()

    for (const [list, reload] of [
      ['ready', 'pending'],
      ['ready', 'error'],
      ['loading', 'idle'],
      ['error', 'idle'],
    ] as const) {
      rerender(<MessageList list={list} reload={reload} messages={[]} />)
      expect(screen.queryByText(EMPTY), `${list}/${reload}`).toBeNull()
    }
    rerender(<MessageList list="ready" reload="idle" messages={[msg(1)]} />)
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('T006-S1 shows "Loading messages…" while loading, beside any message already held', () => {
    const { rerender } = render(<MessageList list="loading" reload="idle" messages={[]} />)
    expect(screen.getByText(LOADING)).toBeInTheDocument()
    rerender(<MessageList list="loading" reload="idle" messages={[msg(3)]} />)
    expect(screen.getByText(LOADING)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    rerender(<MessageList list="ready" reload="idle" messages={[msg(3)]} />)
    expect(screen.queryByText(LOADING)).toBeNull()
  })

  it('T006-S3 shows the text with its line break and the time as <time datetime> in the locale', () => {
    render(<MessageList list="ready" reload="idle" messages={[msg(2, E, 'a\nb'), msg(1)]} />)
    const list = screen.getByRole('list', { name: 'Messages' })
    const [first, second] = within(list).getAllByRole('listitem')

    const text = first?.querySelector('.message__text')
    expect(text?.textContent).toBe('a\nb')
    expect(second).toHaveTextContent('m1')

    const time = first?.querySelector('time')
    expect(time).toHaveAttribute('datetime', CREATED_AT)
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(CREATED_AT))
    expect(time).toHaveTextContent(expected)
  })

  it('T006-S3 App.css keeps the line breaks: white-space pre-wrap on .message__text', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'App.css'), 'utf8')
    const rule = /\.message__text \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/white-space:\s*pre-wrap;/)
  })

  it('T006-F5 renders a <script> message as literal text', () => {
    const attack = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    const { container } = render(
      <MessageList list="ready" reload="idle" messages={[msg(1, E, attack)]} />,
    )
    expect(screen.getByRole('listitem')).toHaveTextContent(attack)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('T006-A1 the list is not a live region', () => {
    render(<MessageList list="ready" reload="idle" messages={[msg(1)]} />)
    const list = screen.getByRole('list', { name: 'Messages' })
    expect(list.closest('[aria-live], [role="log"], [role="status"], [role="alert"]')).toBeNull()
  })

  it('T006-A1 the list says role="list" itself: Safari drops the semantics of a list with list-style: none', () => {
    render(<MessageList list="ready" reload="idle" messages={[msg(1)]} />)
    expect(screen.getByRole('list', { name: 'Messages' })).toHaveAttribute('role', 'list')
  })
})
