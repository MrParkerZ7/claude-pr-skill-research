// T-013: scenario cases for SPEC-001 D1 and D2 (soft-test-scenario), the whole page with fetch and EventSource stubbed.
// A case id comes first in each name; the cases are the ones the unit and page suites of T-006 do not already prove.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { LIST_URL } from '../../api/messages'
import { FakeEventSource } from '../FakeEventSource'
import {
  E,
  E2,
  advance,
  answer,
  failCall,
  fakeFetch,
  listOf,
  msg,
  reply,
  type FakeFetch,
} from '../fixtures'

// The page's timers are all `setTimeout` (the 10 s request limit and the reconnect wait). Faking only those keeps
// `vi.getTimerCount()` an exact count of them: a bare `vi.useFakeTimers()` also fakes the DOM environment's own timers (an
// interval, animation-frame and `setImmediate` callbacks), which an interaction starts and which are not the page's, so
// a "timers 0" read after a click would count them.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  FakeEventSource.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderPage(): FakeFetch {
  const http = fakeFetch()
  vi.stubGlobal('fetch', http.fn)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<App />)
  return http
}

const EMPTY = 'No messages yet. Send the first one.'
const LOADING = 'Loading messages…'
const pill = () => screen.getByRole('status')
const textbox = () => screen.getByRole('textbox', { name: 'Message' })
const button = (name: string) => screen.getByRole('button', { name })
const noButton = (name: string) => screen.queryByRole('button', { name })
const texts = () =>
  within(screen.getByRole('list', { name: 'Messages' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.message__text')?.textContent)
const sources = () => FakeEventSource.instances.length
const latest = () => FakeEventSource.latest()
const source = (index: number) => FakeEventSource.instances[index]

/** First GET answered with E ids 1–3, the stream opened. */
async function livePage(): Promise<FakeFetch> {
  const http = renderPage()
  await answer(http.call(0), reply(200, listOf(E, [1, 2, 3])))
  act(() => latest().open())
  return http
}

/** Closes the stream and fails attempts 1 to 4: the page is then waiting 16 000 ms for attempt 5 (5 sources). */
async function toAttempt5Wait() {
  act(() => latest().fail('closed'))
  for (const delay of [1000, 2000, 4000, 8000]) {
    await advance(delay)
    act(() => latest().fail('closed'))
  }
}

/** Then attempt 5 fails too: Offline, 6 sources. */
async function goOffline() {
  await toAttempt5Wait()
  await advance(16_000)
  act(() => latest().fail('closed'))
}

function send(draft: string) {
  fireEvent.change(textbox(), { target: { value: draft } })
  fireEvent.click(button('Send'))
}

describe('T-013 SPEC-001 D1, D2 scenario cases', () => {
  // serves-spec: SPEC-001 #D1 · Required-Success
  it('SC-messages-RD1c-S1 a reload that returns an empty new run shows the empty copy', async () => {
    const http = await livePage()
    act(() => latest().resync({ reason: 'restart', epoch: E2, latestId: 0 }))
    expect(screen.queryByRole('list', { name: 'Messages' })).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()

    await answer(http.last(), reply(200, listOf(E2, [])))
    expect(screen.getByText(EMPTY)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Messages' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(pill()).toHaveTextContent(/^Live$/)
    expect(sources()).toBe(1)

    act(() => latest().fail('closed'))
    await advance(1000)
    expect(latest().after).toBe('89abcdef.0')
  })

  // serves-spec: SPEC-001 #D1 · Boundary
  it("SC-messages-RD1d-B1 the Retry GET's 10 s timeout, and a second Retry", async () => {
    const http = renderPage()
    await failCall(http.call(0))
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load messages.")

    fireEvent.click(button('Retry'))
    expect(http.of('GET').map((c) => c.url)).toEqual([LIST_URL, LIST_URL])
    expect(screen.getByText(LOADING)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()

    await advance(9_999)
    expect(http.call(1).signal.aborted).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(LOADING)).toBeInTheDocument()

    await advance(1)
    expect(http.call(1).signal.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load messages.")
    expect(button('Retry')).toBeInTheDocument()
    expect(pill()).toHaveTextContent(/^Not connected$/)
    expect(sources()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.click(button('Retry'))
    expect(http.of('GET')).toHaveLength(3)
    expect(http.call(2).url).toBe(LIST_URL)

    await answer(http.last(), reply(200, listOf(E, [1])))
    expect(texts()).toEqual(['m1'])
    expect(sources()).toBe(1)
    expect(latest().after).toBe('0123abcd.1')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(pill()).toHaveTextContent(/^Connecting…$/)
  })

  // serves-spec: SPEC-001 #D1 · Boundary
  it("SC-messages-RD1d-B2 the reload Retry GET's 10 s timeout, and a second Retry", async () => {
    const http = await livePage()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(http.last())
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")

    fireEvent.click(button('Retry'))
    expect(http.of('GET')).toHaveLength(3)
    expect(http.last().url).toBe(LIST_URL)
    expect(screen.queryByRole('alert')).toBeNull()

    await advance(9_999)
    expect(http.call(2).signal.aborted).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()

    await advance(1)
    expect(http.call(2).signal.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")
    expect(button('Retry')).toBeInTheDocument()
    expect(texts()).toEqual(['m3', 'm2', 'm1'])
    expect(pill()).toHaveTextContent(/^Live$/)
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.click(button('Retry'))
    expect(http.of('GET')).toHaveLength(4)
    await answer(http.last(), reply(200, listOf(E, [1, 2, 3, 4, 5])))
    expect(texts()).toEqual(['m5', 'm4', 'm3', 'm2', 'm1'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2c-T1 the first stream closes before it ever opened', async () => {
    const http = renderPage()
    await answer(http.call(0), reply(200, listOf(E, [1, 2, 3])))
    expect(pill()).toHaveTextContent(/^Connecting…$/)
    expect(sources()).toBe(1)

    act(() => latest().fail('closed'))
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(source(0)?.closeCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(noButton('Reconnect')).toBeNull()

    await advance(999)
    expect(sources()).toBe(1)
    await advance(1)
    expect(sources()).toBe(2)
    expect(latest().after).toBe('0123abcd.3')
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
    expect(vi.getTimerCount()).toBe(0)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2c-T2 the browser retries, then gives up: attempt 1', async () => {
    await livePage()
    for (let i = 0; i < 2; i += 1) {
      act(() => latest().fail('connecting'))
      expect(pill()).toHaveTextContent(/^Reconnecting…$/)
      expect(sources()).toBe(1)
      expect(source(0)?.closeCalls).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }

    act(() => latest().fail('closed'))
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(source(0)?.closeCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    await advance(999)
    expect(sources()).toBe(1)
    await advance(1)
    expect(sources()).toBe(2)
    expect(latest().after).toBe('0123abcd.3')

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2e-T1 after Reconnect, an open resets the count', async () => {
    await livePage()
    await goOffline()
    expect(pill()).toHaveTextContent(/^Offline$/)
    expect(sources()).toBe(6)

    fireEvent.click(button('Reconnect'))
    expect(sources()).toBe(7)
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(vi.getTimerCount()).toBe(0)

    for (let i = 0; i < 2; i += 1) {
      act(() => latest().fail('connecting'))
      expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
      expect(sources()).toBe(7)
      expect(vi.getTimerCount()).toBe(0)
    }

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)

    act(() => latest().fail('closed'))
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(vi.getTimerCount()).toBe(1)

    await advance(999)
    expect(sources()).toBe(7)
    await advance(1)
    expect(sources()).toBe(8)
    expect(latest().after).toBe('0123abcd.3')
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2f-T1 a POST sent before Offline, answered in Offline, leaves Offline', async () => {
    const http = await livePage()
    await toAttempt5Wait()
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 5 of 5\)$/)
    expect(sources()).toBe(5)

    await advance(10_000)
    expect(sources()).toBe(5)

    send('late')
    const post = http.last()
    expect(http.of('POST')).toHaveLength(1)

    await advance(6_000)
    expect(sources()).toBe(6)

    act(() => latest().fail('closed'))
    expect(pill()).toHaveTextContent(/^Offline$/)
    expect(button('Reconnect')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)

    await answer(post, reply(201, msg(4, E, 'late')))
    expect(texts()[0]).toBe('late')
    expect(textbox()).toHaveValue('')
    expect(sources()).toBe(7)
    expect(latest().after).toBe('0123abcd.3')
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(noButton('Reconnect')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2f-T2 a POST sent in Offline, answered after Reconnect, opens no second stream', async () => {
    const http = await livePage()
    await goOffline()
    expect(sources()).toBe(6)

    send('hi')
    const post = http.last()

    fireEvent.click(button('Reconnect'))
    expect(sources()).toBe(7)
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)

    await answer(post, reply(201, msg(4, E, 'hi')))
    expect(sources()).toBe(7)
    expect(source(6)?.closeCalls).toBe(0)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(texts()[0]).toBe('hi')
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2f-T3 a reload Retry pressed before Offline, answered in Offline, leaves Offline', async () => {
    const http = await livePage()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(http.last())
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")

    await toAttempt5Wait()
    expect(sources()).toBe(5)
    await advance(10_000)

    fireEvent.click(button('Retry'))
    const reload = http.last()
    expect(reload.url).toBe(LIST_URL)
    expect(screen.queryByRole('alert')).toBeNull()

    await advance(6_000)
    expect(sources()).toBe(6)
    act(() => latest().fail('closed'))
    expect(pill()).toHaveTextContent(/^Offline$/)
    expect(vi.getTimerCount()).toBe(1)

    await answer(reload, reply(200, listOf(E, [1, 2, 3, 4, 5])))
    expect(sources()).toBe(7)
    expect(latest().after).toBe('0123abcd.5')
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(texts()).toEqual(['m5', 'm4', 'm3', 'm2', 'm1'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().fail('connecting'))
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
  })

  // serves-spec: SPEC-001 #D2 · Required-Success
  it('SC-messages-RD2f-T4 a reload Retry pressed in Offline, answered after Reconnect, opens no second stream', async () => {
    const http = await livePage()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(http.last())
    await goOffline()
    expect(sources()).toBe(6)

    fireEvent.click(button('Retry'))
    const reload = http.last()
    fireEvent.click(button('Reconnect'))
    expect(sources()).toBe(7)

    await answer(reload, reply(200, listOf(E, [1, 2, 3, 4, 5])))
    expect(sources()).toBe(7)
    expect(source(6)?.closeCalls).toBe(0)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(texts()).toEqual(['m5', 'm4', 'm3', 'm2', 'm1'])
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().open())
    expect(pill()).toHaveTextContent(/^Live$/)
  })

  // serves-spec: SPEC-001 #D2 · Required-Fail
  it('SC-messages-RD2f-F1 a non-2xx POST answer in Offline stays Offline', async () => {
    const http = await livePage()
    await goOffline()

    send('x')
    await answer(
      http.last(),
      reply(
        400,
        { title: 'Invalid request', status: 400, field: 'text', reason: 'too_long' },
        'application/problem+json',
      ),
    )
    expect(pill()).toHaveTextContent(/^Offline$/)
    expect(button('Reconnect')).toBeInTheDocument()
    expect(sources()).toBe(6)
    expect(vi.getTimerCount()).toBe(0)
    expect(screen.getByRole('alert')).toHaveTextContent('Message is longer than 280 characters.')
    expect(textbox()).toHaveValue('x')
  })

  // serves-spec: SPEC-001 #D2 · Required-Fail
  it('SC-messages-RD2f-F2 a non-2xx reload answer in Offline stays Offline', async () => {
    const http = await livePage()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(http.last())
    await goOffline()

    fireEvent.click(button('Retry'))
    await answer(http.last(), reply(500))
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reload messages.")
    expect(button('Retry')).toBeInTheDocument()
    expect(pill()).toHaveTextContent(/^Offline$/)
    expect(button('Reconnect')).toBeInTheDocument()
    expect(sources()).toBe(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D2 · Required-Fail
  it('SC-messages-RD2f-F3 a 201 while Connecting opens no new stream', async () => {
    const http = renderPage()
    await answer(http.call(0), reply(200, listOf(E, [1, 2, 3])))

    send('hi')
    await answer(http.last(), reply(201, msg(4, E, 'hi')))
    expect(sources()).toBe(1)
    expect(source(0)?.closeCalls).toBe(0)
    expect(pill()).toHaveTextContent(/^Connecting…$/)
    expect(vi.getTimerCount()).toBe(0)
    expect(texts()[0]).toBe('hi')
  })

  // serves-spec: SPEC-001 #D2 · Required-Fail
  it('SC-messages-RD2f-F4 a 201 while the browser retries opens no new stream', async () => {
    const http = await livePage()
    act(() => latest().fail('connecting'))

    send('hi')
    await answer(http.last(), reply(201, msg(4, E, 'hi')))
    expect(sources()).toBe(1)
    expect(source(0)?.closeCalls).toBe(0)
    expect(pill()).toHaveTextContent(/^Reconnecting…$/)
    expect(vi.getTimerCount()).toBe(0)
    expect(texts()[0]).toBe('hi')
  })

  // serves-spec: SPEC-001 #D2 · Required-Fail
  it('SC-messages-RD2f-F5 a 201 while waiting for attempt 1 neither opens a stream nor moves the wait', async () => {
    const http = await livePage()
    act(() => latest().fail('closed'))
    expect(vi.getTimerCount()).toBe(1)

    send('hi')
    await answer(http.last(), reply(201, msg(4, E, 'hi')))
    expect(sources()).toBe(1)
    expect(pill()).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
    expect(vi.getTimerCount()).toBe(1)
    expect(texts()[0]).toBe('hi')

    await advance(999)
    expect(sources()).toBe(1)
    await advance(1)
    expect(sources()).toBe(2)
    expect(latest().after).toBe('0123abcd.3')
  })
})
