import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { LIST_URL } from './api/messages'
import { backoffDelay } from './feed/useMessageFeed'
import { FakeEventSource } from './test/FakeEventSource'
import { E, E2, advance, answer, failCall, fakeFetch, listOf, msg, reply } from './test/fixtures'

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * The page with the browser's fetch and EventSource stubbed. `keyboard` lets fake time also follow real time: Testing
 * Library ends every user-event call with a real `setTimeout(0)`, which it advances itself only under Jest.
 */
function renderApp(options: { strict?: boolean; keyboard?: boolean } = {}) {
  if (options.keyboard === true) vi.useFakeTimers({ shouldAdvanceTime: true })
  const http = fakeFetch()
  vi.stubGlobal('fetch', http.fn)
  vi.stubGlobal('EventSource', FakeEventSource)
  const view = render(
    options.strict === true ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  )
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
  return { http, view, user }
}

type Page = ReturnType<typeof renderApp>

async function liveApp(list = listOf(E, [1, 2, 3]), options: { keyboard?: boolean } = {}) {
  const page = renderApp(options)
  await answer(page.http.call(0), reply(200, list))
  act(() => FakeEventSource.latest().open())
  return page
}

async function goOffline() {
  act(() => FakeEventSource.latest().fail('closed'))
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await advance(backoffDelay(attempt))
    act(() => FakeEventSource.latest().fail('closed'))
  }
}

const LOADING = 'Loading messages…'
const EMPTY = 'No messages yet. Send the first one.'
const NETWORK = "Couldn't send. Check your connection and try again."

const pill = () => screen.getByRole('status')
const textbox = () => screen.getByRole('textbox', { name: 'Message' })
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const retryButton = () => screen.getByRole('button', { name: 'Retry' })
const list = () => screen.getByRole('list', { name: 'Messages' })
const texts = () =>
  within(list())
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.message__text')?.textContent)
const type = (value: string) => fireEvent.change(textbox(), { target: { value } })
const enter = (init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(textbox(), { key: 'Enter', ...init })
const posts = (page: Page) => page.http.of('POST')

/** Types a draft, presses Send and answers the POST. */
async function sendAnswered(page: Page, draft: string, response: Response) {
  type(draft)
  fireEvent.click(sendButton())
  await answer(page.http.last(), response)
}

describe('App', () => {
  it('T002-S1 renders a level-1 heading "Live messages", a banner and one main', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1, name: 'Live messages' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })
})

describe('loading (SPEC-001 D1, D2)', () => {
  it('T006-S1 loads limit=100 showing Loading and Not connected with a usable composer, then 3 items newest first, Connecting…, Live', async () => {
    const { http } = renderApp()
    expect(http.calls.map((c) => c.url)).toEqual([LIST_URL])
    expect(screen.getByText(LOADING)).toBeInTheDocument()
    expect(pill()).toHaveTextContent('Not connected')
    type('hi')
    expect(textbox()).toHaveValue('hi')
    expect(sendButton()).toBeEnabled()

    await answer(http.call(0), reply(200, listOf(E, [1, 2, 3])))
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(texts()).toEqual(['m3', 'm2', 'm1'])
    expect(FakeEventSource.instances.map((s) => s.after)).toEqual([`${E}.3`])
    expect(pill()).toHaveTextContent('Connecting…')

    act(() => FakeEventSource.latest().open())
    expect(pill()).toHaveTextContent('Live')
  })

  it('T006-S1 under StrictMode, as main.tsx mounts it, the page ends with one stream', async () => {
    const { http } = renderApp({ strict: true })
    expect(http.calls).toHaveLength(2)
    await answer(http.last(), reply(200, listOf(E, [1])))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
  })

  it('T006-S2 an empty list shows the empty copy', async () => {
    const { http } = renderApp()
    await answer(http.call(0), reply(200, listOf(E, [])))
    expect(screen.getByText(EMPTY)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Messages' })).toBeNull()
  })

  it.each([
    ['a network failure', (page: Page) => failCall(page.http.call(0))],
    ['a 500', (page: Page) => answer(page.http.call(0), reply(500))],
    [
      'no answer in 10 s',
      async () => {
        await advance(9_999)
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.getByText(LOADING)).toBeInTheDocument()
        await advance(1)
      },
    ],
  ])(
    'T006-F1 a load that fails by %s shows the alert and Retry; Retry, pressed twice, makes one GET and focuses the textarea',
    async (_, fail) => {
      const page = renderApp()
      await fail(page)
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load messages.")
      expect(pill()).toHaveTextContent('Not connected')
      expect(screen.queryByText(LOADING)).toBeNull()
      type('still here')
      expect(sendButton()).toBeEnabled()
      expect(textbox()).not.toHaveAttribute('readonly')

      const retry = retryButton()
      retry.focus()
      act(() => {
        retry.click()
        retry.click()
      })
      expect(screen.getByText(LOADING)).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(page.http.calls.map((c) => c.url)).toEqual([LIST_URL, LIST_URL])
      expect(textbox()).toHaveFocus()

      await answer(page.http.last(), reply(200, listOf(E, [1])))
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(texts()).toEqual(['m1'])
    },
  )
})

describe('the stream (SPEC-001 D2, D5, D6)', () => {
  it('T006-S3 a frame with text "a\\nb" goes on top, on two lines, with a time[datetime]', async () => {
    await liveApp()
    act(() => FakeEventSource.latest().message(msg(4, E, 'a\nb')))
    expect(texts()).toEqual(['a\nb', 'm3', 'm2', 'm1'])
    const top = within(list()).getAllByRole('listitem')[0]
    expect(top?.querySelector('time[datetime]')).toHaveAttribute('datetime', msg(4).createdAt)
  })

  it('T006-F5 a <script>alert(1)</script> message shows literally and adds no script element', async () => {
    const { view } = await liveApp()
    act(() => FakeEventSource.latest().message(msg(4, E, '<script>alert(1)</script>')))
    expect(texts()[0]).toBe('<script>alert(1)</script>')
    expect(view.container.querySelector('script')).toBeNull()
  })

  it('T006-S10 the pill names each attempt from the moment its wait starts, then says Live', async () => {
    await liveApp()
    act(() => FakeEventSource.latest().fail('closed'))
    expect(pill()).toHaveTextContent('Reconnecting… (attempt 1 of 5)')
    await advance(1000)
    act(() => FakeEventSource.latest().fail('closed'))
    expect(pill()).toHaveTextContent('Reconnecting… (attempt 2 of 5)')
    await advance(2000)
    act(() => FakeEventSource.latest().open())
    expect(pill()).toHaveTextContent('Live')
  })

  it('T006-S9 an error while CONNECTING says Reconnecting…, then Live', async () => {
    await liveApp()
    act(() => FakeEventSource.latest().fail('connecting'))
    expect(pill()).toHaveTextContent(/^Reconnecting…$/)
    act(() => FakeEventSource.latest().open())
    expect(pill()).toHaveTextContent('Live')
  })

  it('T006-F11 after the 5th failed attempt: Offline and Reconnect', async () => {
    await liveApp()
    await goOffline()
    expect(pill()).toHaveTextContent('Offline')
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-S12 Offline: Reconnect opens a stream at once as attempt 1 and focuses the textarea', async () => {
    await liveApp()
    await goOffline()
    const reconnect = screen.getByRole('button', { name: 'Reconnect' })
    reconnect.focus()
    fireEvent.click(reconnect)
    expect(FakeEventSource.instances).toHaveLength(7)
    expect(FakeEventSource.latest().after).toBe(`${E}.3`)
    expect(pill()).toHaveTextContent('Reconnecting… (attempt 1 of 5)')
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect(textbox()).toHaveFocus()
  })

  it('T006-S12 Offline: Send shows the message, and its 201 takes the pill out of Offline', async () => {
    const page = await liveApp()
    await goOffline()
    await sendAnswered(page, 'back', reply(201, msg(4, E, 'back')))
    expect(texts()[0]).toBe('back')
    expect(pill()).toHaveTextContent('Reconnecting… (attempt 1 of 5)')
    expect(FakeEventSource.instances).toHaveLength(7)
  })

  it('T006-S14 Offline after a restart: a 201 with E2 shows only it, leaves Offline and reloads with no empty copy', async () => {
    const page = await liveApp()
    await goOffline()
    await sendAnswered(page, 'new run', reply(201, msg(1, E2, 'new run')))
    expect(texts()).toEqual(['new run'])
    expect(pill()).not.toHaveTextContent('Offline')
    expect(FakeEventSource.latest().after).toBe(`${E2}.0`)
    expect(page.http.last().url).toBe(LIST_URL)
    expect(screen.queryByText(EMPTY)).toBeNull()
  })
})

describe('the reload (SPEC-001 D5)', () => {
  it('T006-F9 a failed reload keeps the list and the pill, with "Couldn\'t reload messages." and Retry; Retry focuses and merges', async () => {
    const page = await liveApp()
    act(() => FakeEventSource.latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    expect(page.http.last().url).toBe(LIST_URL)
    await failCall(page.http.last())

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")
    expect(texts()).toEqual(['m3', 'm2', 'm1'])
    expect(pill()).toHaveTextContent('Live')

    const retry = retryButton()
    retry.focus()
    fireEvent.click(retry)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(textbox()).toHaveFocus()
    expect(page.http.last().url).toBe(LIST_URL)
    expect(page.http.calls).toHaveLength(3)

    await answer(page.http.last(), reply(200, listOf(E, [1, 2, 3, 4, 5])))
    expect(texts()).toEqual(['m5', 'm4', 'm3', 'm2', 'm1'])
  })

  it('T006-F9 after a restart drop: no empty copy while the reload is pending, then only the alert', async () => {
    const page = await liveApp()
    act(() => FakeEventSource.latest().resync({ reason: 'restart', epoch: E2, latestId: 2 }))
    expect(screen.queryByRole('list', { name: 'Messages' })).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(screen.queryByText(LOADING)).toBeNull()

    await failCall(page.http.last())
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")
    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Messages' })).toBeNull()
  })

  it('T006-S13 a 201 while the load has failed is shown; after Retry it shows once', async () => {
    const page = renderApp()
    await failCall(page.http.call(0))
    await sendAnswered(page, 'first', reply(201, msg(3, E, 'first')))
    expect(texts()).toEqual(['first'])
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load messages.")
    expect(pill()).toHaveTextContent('Not connected')

    fireEvent.click(retryButton())
    await answer(
      page.http.last(),
      reply(200, { epoch: E, messages: [msg(3, E, 'first'), msg(2), msg(1)], latestId: 3 }),
    )
    expect(texts()).toEqual(['first', 'm2', 'm1'])
  })
})

describe('the composer (SPEC-001 D3, D4)', () => {
  it('T006-S4 Send posts {"text":"hello"}; the textarea is read-only and focused meanwhile; the draft clears and the message shows once', async () => {
    const page = await liveApp(undefined, { keyboard: true })
    await page.user.click(textbox())
    await page.user.keyboard('hello')
    await page.user.click(sendButton())

    const sent = page.http.last()
    expect(sent.init.method).toBe('POST')
    expect(sent.body).toEqual({ text: 'hello' })
    expect(textbox()).toHaveAttribute('readonly')
    expect(textbox()).toHaveFocus()
    expect(sendButton()).toBeDisabled()

    await answer(sent, reply(201, msg(4, E, 'hello')))
    expect(textbox()).toHaveValue('')
    expect(textbox()).toHaveFocus()
    expect(textbox()).not.toHaveAttribute('readonly')
    expect(texts()).toEqual(['hello', 'm3', 'm2', 'm1'])

    act(() => FakeEventSource.latest().message(msg(4, E, 'hello')))
    expect(texts()).toEqual(['hello', 'm3', 'm2', 'm1'])
  })

  it('T006-S5 Enter sends; Shift+Enter inserts a newline', async () => {
    const page = await liveApp(undefined, { keyboard: true })
    await page.user.click(textbox())
    await page.user.keyboard('a{Shift>}{Enter}{/Shift}b')
    expect(textbox()).toHaveValue('a\nb')
    expect(posts(page)).toHaveLength(0)

    await page.user.keyboard('{Enter}')
    expect(posts(page)).toHaveLength(1)
    expect(page.http.last().body).toEqual({ text: 'a\nb' })
  })

  it('T006-F4 a draft of only spaces disables Send; 281 code points: neither Enter nor Send posts', async () => {
    const page = await liveApp()
    type('   ')
    expect(sendButton()).toBeDisabled()
    type('a'.repeat(281))
    expect(screen.getByText('281 / 280')).toHaveClass('composer__counter--over')
    expect(sendButton()).toBeDisabled()
    enter()
    fireEvent.click(sendButton())
    expect(posts(page)).toHaveLength(0)
    expect(textbox()).toHaveValue('a'.repeat(281))
  })

  it('T006-F6 Enter twice while sending makes one POST, and the textarea stays read-only', async () => {
    const page = await liveApp()
    type('hi')
    enter()
    expect(textbox()).toHaveAttribute('readonly')
    enter()
    expect(textbox()).toHaveAttribute('readonly')
    expect(posts(page)).toHaveLength(1)
    await answer(page.http.last(), reply(201, msg(4, E, 'hi')))
    expect(posts(page)).toHaveLength(1)
  })

  it('T006-F10 Enter during IME composition sends nothing', async () => {
    const page = await liveApp()
    type('にほん')
    enter({ isComposing: true })
    expect(posts(page)).toHaveLength(0)
  })

  it('T006-F2 a 400 too_long shows an inline alert linked to the textarea, keeps the draft, and an edit clears it', async () => {
    const page = await liveApp()
    const problem = { title: 'Invalid request', status: 400, field: 'text', reason: 'too_long' }
    await sendAnswered(page, 'long', reply(400, problem, 'application/problem+json'))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Message is longer than 280 characters.')
    expect(textbox().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id)
    expect(textbox()).toHaveAccessibleDescription(/Message is longer than 280 characters\./)
    expect(textbox()).toHaveValue('long')

    type('longer')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('T006-F3 a network error, a timeout and a 503 text/plain give the network copy and keep the draft; a later success clears it', async () => {
    const page = await liveApp()
    type('hi')
    fireEvent.click(sendButton())
    await failCall(page.http.last())
    expect(screen.getByRole('alert')).toHaveTextContent(NETWORK)
    expect(textbox()).toHaveValue('hi')

    fireEvent.click(sendButton())
    await advance(9_999)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(textbox()).toHaveAttribute('readonly')
    await advance(1)
    expect(screen.getByRole('alert')).toHaveTextContent(NETWORK)
    expect(textbox()).toHaveValue('hi')

    fireEvent.click(sendButton())
    await answer(page.http.last(), reply(503, 'Service Unavailable', 'text/plain'))
    expect(screen.getByRole('alert')).toHaveTextContent(NETWORK)
    expect(textbox()).toHaveValue('hi')

    fireEvent.click(sendButton())
    await answer(page.http.last(), reply(201, msg(4, E, 'hi')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(textbox()).toHaveValue('')
    expect(posts(page)).toHaveLength(4)
  })

  it('T006-F7 shows the D4 copy for bidi_control, control_character, blank, 413 and the other problems', async () => {
    const page = await liveApp()
    const problem = (status: number, body: object) =>
      reply(status, { title: 'x', status, ...body }, 'application/problem+json')
    for (const [response, copy] of [
      [
        problem(400, { reason: 'bidi_control' }),
        "Message contains characters that aren't allowed.",
      ],
      [
        problem(400, { reason: 'control_character' }),
        "Message contains characters that aren't allowed.",
      ],
      [problem(400, { reason: 'blank' }), 'Write something first.'],
      [problem(413, { detail: 'Maximum upload size exceeded' }), 'Message is too large.'],
      [problem(422, { detail: 'Not like that.' }), 'Not like that.'],
      [problem(422, {}), "Couldn't send (error 422)."],
      [reply(418), "Couldn't send (error 418)."],
    ] as const) {
      await sendAnswered(page, `try ${copy}`, response)
      expect(screen.getByRole('alert')).toHaveTextContent(copy)
    }
  })
})

describe('keyboard and order (SPEC-001 D1, D6)', () => {
  it('T006-A1 the DOM order is header, pill, composer, list alert, list', async () => {
    const page = await liveApp()
    act(() => FakeEventSource.latest().resync({ reason: 'gap', epoch: E, latestId: 3 }))
    await failCall(page.http.last())

    const order = [
      screen.getByRole('heading', { level: 1 }),
      pill(),
      textbox(),
      sendButton(),
      screen.getByRole('alert'),
      retryButton(),
      list(),
    ]
    for (let i = 1; i < order.length; i += 1) {
      const previous = order[i - 1] as Element
      const current = order[i] as Element
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
  })

  it('T006-A1 by keyboard only: Tab reaches the textarea, Enter sends, and the send error is announced', async () => {
    const page = await liveApp(undefined, { keyboard: true })
    await page.user.tab()
    expect(textbox()).toHaveFocus()
    await page.user.keyboard('hi{Enter}')
    expect(posts(page)).toHaveLength(1)

    await answer(page.http.last(), reply(400, { reason: 'blank' }, 'application/problem+json'))
    expect(screen.getByRole('alert')).toHaveTextContent('Write something first.')
    expect(textbox()).toHaveAccessibleDescription(/Write something first\./)
    expect(textbox()).toHaveFocus()
  })

  it('T006-A1 by keyboard only: Retry is reachable after the textarea, and Reconnect first when Offline', async () => {
    const page = renderApp({ keyboard: true })
    await failCall(page.http.call(0))
    await page.user.tab()
    expect(textbox()).toHaveFocus()
    await page.user.tab()
    expect(retryButton()).toHaveFocus()
    await page.user.keyboard('{Enter}')
    expect(textbox()).toHaveFocus()
    await answer(page.http.last(), reply(200, listOf(E, [1])))
    act(() => FakeEventSource.latest().open())

    await goOffline()
    ;(document.activeElement as HTMLElement).blur()
    await page.user.tab()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toHaveFocus()
    await page.user.keyboard('{Enter}')
    expect(textbox()).toHaveFocus()
    expect(pill()).toHaveTextContent('Reconnecting… (attempt 1 of 5)')
  })
})
