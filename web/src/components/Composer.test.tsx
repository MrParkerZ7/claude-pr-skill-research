import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiError } from '../api/problem'
import { Composer } from './Composer'

function composer(props: { draft?: string; sending?: boolean; error?: ApiError | null } = {}) {
  const onEdit = vi.fn()
  const onSend = vi.fn()
  const inputRef = createRef<HTMLTextAreaElement>()
  const element = (p: typeof props) => (
    <Composer
      draft={p.draft ?? ''}
      sending={p.sending ?? false}
      error={p.error ?? null}
      inputRef={inputRef}
      onEdit={onEdit}
      onSend={onSend}
    />
  )
  const view = render(element(props))
  return {
    ...view,
    onEdit,
    onSend,
    inputRef,
    update: (p: typeof props) => view.rerender(element(p)),
    textbox: () => screen.getByRole('textbox', { name: 'Message' }),
    send: () => screen.getByRole('button', { name: 'Send' }),
    counter: () => document.getElementById('message-counter'),
  }
}

/** Fires keydown and says whether the page prevented the default (a newline). */
const keyDown = (target: Element, init: KeyboardEventInit) => !fireEvent.keyDown(target, init)

describe('Composer (SPEC-001 D3, D4)', () => {
  it('T006-B1 counts code points at 0, 1, 280 and 281: Send off, on, on, off; 281 / 280 in the danger style', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const c = composer()
    for (const [draft, text, enabled, over] of [
      ['', '0 / 280', false, false],
      ['a', '1 / 280', true, false],
      [emoji.repeat(280), '280 / 280', true, false],
      [`${'b'.repeat(281)}`, '281 / 280', false, true],
    ] as const) {
      c.update({ draft })
      expect(c.counter()).toHaveTextContent(text)
      expect(c.send().hasAttribute('disabled'), text).toBe(!enabled)
      expect(c.counter()?.classList.contains('composer__counter--over'), text).toBe(over)
    }
    expect(c.textbox()).toHaveAttribute('aria-describedby', 'message-counter')
    expect(c.textbox()).toHaveAccessibleDescription('281 / 280')
  })

  it('T006-F4 Send is disabled for a draft of only spaces', () => {
    const c = composer({ draft: '   ' })
    expect(c.counter()).toHaveTextContent('0 / 280')
    expect(c.send()).toBeDisabled()
  })

  it('T006-S5 Enter sends and inserts nothing; Shift+Enter inserts a newline and sends nothing', () => {
    const c = composer({ draft: 'hi' })
    expect(keyDown(c.textbox(), { key: 'Enter' })).toBe(true)
    expect(c.onSend).toHaveBeenCalledOnce()

    expect(keyDown(c.textbox(), { key: 'Enter', shiftKey: true })).toBe(false)
    expect(keyDown(c.textbox(), { key: 'a' })).toBe(false)
    expect(c.onSend).toHaveBeenCalledOnce()
  })

  it('T006-F10 Enter during IME composition never sends', () => {
    const c = composer({ draft: 'にほん' })
    expect(keyDown(c.textbox(), { key: 'Enter', isComposing: true })).toBe(false)
    expect(c.onSend).not.toHaveBeenCalled()
  })

  it('T006-F10 Enter that confirms an IME candidate in Safari (isComposing false, keyCode 229) never sends', () => {
    const c = composer({ draft: 'にほん' })
    expect(keyDown(c.textbox(), { key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false)
    expect(c.onSend).not.toHaveBeenCalled()
    expect(keyDown(c.textbox(), { key: 'Enter', keyCode: 13 })).toBe(true)
    expect(c.onSend).toHaveBeenCalledOnce()
  })

  it('T006-F4 Enter on a draft Send refuses is still Send: the hook decides, and no newline is inserted', () => {
    const c = composer({ draft: 'b'.repeat(281) })
    expect(keyDown(c.textbox(), { key: 'Enter' })).toBe(true)
    expect(c.onSend).toHaveBeenCalledOnce()
  })

  it('T006-S4 Send moves focus to the textarea, which is read-only while sending', () => {
    const c = composer({ draft: 'hello' })
    c.send().focus()
    fireEvent.click(c.send())
    expect(c.onSend).toHaveBeenCalledOnce()
    expect(c.textbox()).toHaveFocus()
    expect(c.textbox()).not.toHaveAttribute('readonly')

    c.update({ draft: 'hello', sending: true })
    expect(c.textbox()).toHaveAttribute('readonly')
    expect(c.send()).toBeDisabled()
    expect(c.textbox()).toHaveFocus()
  })

  it('T006-S4 an edit reports the new text', () => {
    const c = composer()
    fireEvent.change(c.textbox(), { target: { value: 'hey' } })
    expect(c.onEdit).toHaveBeenCalledWith('hey')
  })

  it('T006-F2 a send error is a role=alert line inside the textarea’s aria-describedby', () => {
    const c = composer({
      draft: 'x',
      error: { kind: 'problem', status: 400, problem: { reason: 'too_long' } },
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Message is longer than 280 characters.')
    expect(alert).toHaveAttribute('id', 'send-error')
    expect(c.textbox()).toHaveAttribute('aria-describedby', 'message-counter send-error')
    expect(c.textbox()).toHaveAccessibleDescription(
      '1 / 280 Message is longer than 280 characters.',
    )

    c.update({ draft: 'x' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(c.textbox()).toHaveAttribute('aria-describedby', 'message-counter')
  })
})
