import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_URL } from '../api/messages'
import { FakeEventSource } from '../test/FakeEventSource'
import {
  E,
  E2,
  advance,
  answer,
  contract,
  failCall,
  fakeFetch,
  flush,
  ids,
  listOf,
  msg,
  reply,
  sseFrames,
} from '../test/fixtures'
import type { FeedState } from './feedReducer'
import { backoffDelay, useMessageFeed } from './useMessageFeed'

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

function mount(options: { strict?: boolean; ignoreAbort?: boolean } = {}) {
  const http = fakeFetch({ ignoreAbort: options.ignoreAbort ?? false })
  const view = renderHook(() => useMessageFeed({ fetch: http.fn, EventSource: FakeEventSource }), {
    reactStrictMode: options.strict ?? false,
  })
  return {
    http,
    view,
    state: (): FeedState => view.result.current.state,
    feed: () => view.result.current,
  }
}

type Page = ReturnType<typeof mount>

/** The first list load answered; the stream constructed but not open. */
async function loaded(list = listOf(E, [1, 2, 3]), options: { ignoreAbort?: boolean } = {}) {
  const page = mount(options)
  await answer(page.http.call(0), reply(200, list))
  return page
}

async function live(list = listOf(E, [1, 2, 3]), options: { ignoreAbort?: boolean } = {}) {
  const page = await loaded(list, options)
  act(() => FakeEventSource.latest().open())
  return page
}

const latest = () => FakeEventSource.latest()
const sources = () => FakeEventSource.instances.length
const idsOf = (page: Page) => page.state().messages.map((m) => m.id)

/** Closes the live stream and fails all five retries. */
async function goOffline(page: Page) {
  act(() => latest().fail('closed'))
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt })
    await advance(backoffDelay(attempt))
    act(() => latest().fail('closed'))
  }
  expect(page.state().connection).toBe('offline')
}

async function post(page: Page, text: string) {
  act(() => page.feed().edit(text))
  act(() => page.feed().send())
  return page.http.last()
}

describe('the first load and the stream (SPEC-001 D1, D2, D5)', () => {
  it('T006-S1 asks for limit=100, then opens one stream after=E.<latestId>: Connecting…, then Live', async () => {
    const page = mount()
    expect(page.http.calls.map((c) => c.url)).toEqual([LIST_URL])
    expect(page.state()).toMatchObject({ list: 'loading', connection: 'none' })
    expect(sources()).toBe(0)

    await answer(page.http.call(0), reply(200, listOf(E, [1, 2, 3])))
    expect(sources()).toBe(1)
    expect(latest().url).toBe('/api/messages/stream?after=0123abcd.3')
    expect(page.state()).toMatchObject({ list: 'ready', connection: 'connecting', attempt: 0 })

    act(() => latest().open())
    expect(page.state()).toMatchObject({ connection: 'live', attempt: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-S1 under StrictMode ends with one stream: the first mount’s GET is aborted and its answer ignored', async () => {
    const page = mount({ strict: true, ignoreAbort: true })
    expect(page.http.calls).toHaveLength(2)
    expect(page.http.call(0).signal.aborted).toBe(true)
    expect(page.http.call(1).signal.aborted).toBe(false)

    await answer(page.http.call(0), reply(200, listOf(E, [1])))
    expect(sources()).toBe(0)
    expect(page.state().list).toBe('loading')

    await answer(page.http.call(1), reply(200, listOf(E, [1, 2])))
    expect(sources()).toBe(1)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
    expect(latest().after).toBe(`${E}.2`)
  })

  it('T006-F1 a first GET with no answer gives up at 10 000 ms, not at 9 999 ms', async () => {
    const page = mount()
    await advance(9_999)
    expect(page.http.call(0).signal.aborted).toBe(false)
    expect(page.state().list).toBe('loading')

    await advance(1)
    expect(page.http.call(0).signal.aborted).toBe(true)
    expect(page.state()).toMatchObject({ list: 'error', connection: 'none' })
    expect(sources()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-F1 Retry twice at once makes one GET with limit=100; its success opens one stream', async () => {
    const page = mount()
    await answer(page.http.call(0), reply(500))
    expect(page.state().list).toBe('error')
    expect(vi.getTimerCount()).toBe(0)

    act(() => {
      page.feed().retry()
      page.feed().retry()
    })
    expect(page.http.calls.map((c) => c.url)).toEqual([LIST_URL, LIST_URL])
    expect(page.state().list).toBe('loading')

    await answer(page.http.last(), reply(200, listOf(E, [1])))
    expect(sources()).toBe(1)
    expect(page.state()).toMatchObject({ list: 'ready', connection: 'connecting' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-F1 Retry does nothing unless the load failed', async () => {
    const page = mount()
    act(() => page.feed().retry())
    expect(page.http.calls).toHaveLength(1)
    await answer(page.http.call(0), reply(200, listOf(E, [1])))
    act(() => page.feed().retry())
    expect(page.http.calls).toHaveLength(1)
  })
})

describe('the contract fixtures (SPEC-001 A1, B1, C1)', () => {
  it('T006-K1 message-list.json loads, and the frames of stream-sample.txt merge', async () => {
    const page = mount()
    await answer(page.http.call(0), reply(200, contract.messageList))
    expect(page.state().messages.map((m) => [m.epoch, m.id, m.text])).toEqual([
      ['3f9a1c2e', 8, 'Second'],
      ['3f9a1c2e', 7, 'Hello there'],
    ])
    expect(latest().after).toBe('3f9a1c2e.8')

    // The sample stream is of epoch 0123abcd (E): load an empty list of it, then feed the sample's frames.
    const other = mount()
    await answer(other.http.call(0), reply(200, listOf(E, [])))
    act(() => {
      latest().open()
      for (const frame of sseFrames(contract.streamSample)) latest().message(frame.data, frame.id)
    })
    expect(other.state().messages.map((m) => [m.id, m.text])).toEqual([
      [2, 'b'],
      [1, 'a'],
    ])
    expect(other.state().resumeId).toBe(2)
  })
})

describe('frames and resyncs (SPEC-001 D5)', () => {
  it('T006-S3 a frame raises the resume point to its id', async () => {
    const page = await live()
    act(() => latest().message(msg(4, E, 'a\nb')))
    expect(page.state().messages[0]).toEqual(msg(4, E, 'a\nb'))
    expect(page.state().resumeId).toBe(4)
  })

  it('T006-F8 a frame that is not JSON, not a message, or of another epoch is ignored', async () => {
    const page = await live()
    const before = page.state()
    act(() => {
      latest().message('not json', `${E}.4`)
      latest().message({ id: 4, epoch: E }, `${E}.4`)
      latest().message(msg(4), `${E}.5`)
      latest().message(msg(4, E2))
    })
    expect(page.state()).toBe(before)
  })

  it('T006-F8 a resync whose data is not JSON reloads with limit=100 and keeps the resume point', async () => {
    const page = await live()
    act(() => latest().resync('{not json'))
    expect(page.http.calls.map((c) => c.url)).toEqual([LIST_URL, LIST_URL])
    expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 3 })
  })

  it('T006-S6 a gap resync reloads; a frame that arrives meanwhile is kept, and each message shows once', async () => {
    const page = await live(listOf(E, ids(1, 8)))
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 10 }, `${E}.10`))
    expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 10 })

    act(() => latest().message(msg(11)))
    await answer(page.http.last(), reply(200, listOf(E, ids(1, 10))))
    expect(idsOf(page)).toEqual(ids(1, 11).reverse())
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 11 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-S7 after a restart resync the old run is gone, an old-epoch frame is ignored, and the retry resumes from E2.3', async () => {
    const page = await live(listOf(E, ids(1, 50)))
    expect(page.state().resumeId).toBe(50)

    act(() => latest().resync({ reason: 'restart', epoch: E2, latestId: 3 }, `${E2}.3`))
    expect(page.state()).toMatchObject({ epoch: E2, resumeId: 3, messages: [] })
    act(() => latest().message(msg(51)))
    expect(page.state()).toMatchObject({ resumeId: 3, messages: [] })

    await answer(page.http.last(), reply(200, listOf(E2, [1, 2, 3])))
    expect(page.state().messages.map((m) => [m.epoch, m.id])).toEqual([
      [E2, 3],
      [E2, 2],
      [E2, 1],
    ])

    act(() => latest().fail('closed'))
    await advance(1000)
    expect(latest().after).toBe(`${E2}.3`)
    act(() => latest().message(msg(52)))
    expect(idsOf(page)).toEqual([3, 2, 1])
  })

  it('T006-S8 an ahead resync lowers the resume point, and the next stream resumes from it', async () => {
    const page = await live(listOf(E, ids(1, 9)))
    act(() => latest().resync({ reason: 'ahead', epoch: E, latestId: 5 }))
    expect(page.state().resumeId).toBe(5)
    act(() => latest().fail('closed'))
    await advance(1000)
    expect(latest().after).toBe(`${E}.5`)
  })

  it('T006-S15 a second resync aborts the pending reload; the first’s late failure leaves no alert', async () => {
    const page = await live()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    const first = page.http.last()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 6 }))
    const second = page.http.last()

    expect(second).not.toBe(first)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    await flush()
    expect(page.state().reload).toBe('pending')

    await answer(second, reply(200, listOf(E, ids(1, 6))))
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 6 })
    expect(idsOf(page)).toEqual(ids(1, 6).reverse())
  })

  it('T006-S15 the first reload’s answer arriving late is ignored, before and after the second’s', async () => {
    const page = await live(listOf(E, [1, 2, 3]), { ignoreAbort: true })
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 9 }))
    const first = page.http.last()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 6 }))
    const second = page.http.last()

    await answer(first, reply(200, listOf(E, ids(1, 9))))
    expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 6 })
    expect(idsOf(page)).toEqual([3, 2, 1])

    await answer(second, reply(200, listOf(E, ids(1, 6))))
    expect(idsOf(page)).toEqual(ids(1, 6).reverse())
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 6 })
  })

  it('T006-F9 a failed reload keeps the list and the pill; Retry GETs limit=100 and merges as S6', async () => {
    const page = await live()
    act(() => latest().message(msg(4)))
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 6 }))
    await failCall(page.http.last())
    expect(page.state()).toMatchObject({ reload: 'error', connection: 'live', resumeId: 6 })
    expect(idsOf(page)).toEqual([4, 3, 2, 1])

    act(() => page.feed().retryReload())
    expect(page.state().reload).toBe('pending')
    expect(page.http.last().url).toBe(LIST_URL)
    expect(page.http.calls).toHaveLength(3)

    act(() => latest().message(msg(7)))
    await answer(page.http.last(), reply(200, listOf(E, ids(1, 6))))
    expect(idsOf(page)).toEqual(ids(1, 7).reverse())
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 7 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-F9 a reload with no answer fails at 10 000 ms, not before', async () => {
    const page = await live()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 6 }))
    await advance(9_999)
    expect(page.state().reload).toBe('pending')
    await advance(1)
    expect(page.http.last().signal.aborted).toBe(true)
    expect(page.state()).toMatchObject({ reload: 'error', connection: 'live' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-F9 after a restart drop, a pending then failed reload holds no message', async () => {
    const page = await live(listOf(E, ids(1, 5)))
    act(() => latest().resync({ reason: 'restart', epoch: E2, latestId: 2 }))
    expect(page.state()).toMatchObject({ reload: 'pending', messages: [] })
    await failCall(page.http.last())
    expect(page.state()).toMatchObject({ reload: 'error', messages: [], epoch: E2 })
  })

  it('T006-F9 Retry of a reload does nothing unless the reload failed', async () => {
    const page = await live()
    act(() => page.feed().retryReload())
    expect(page.http.calls).toHaveLength(1)
    expect(page.state().reload).toBe('idle')
  })

  it('T006-S10 events from a stream the page has replaced are ignored', async () => {
    const page = await live()
    const old = latest()
    act(() => old.fail('closed'))
    await advance(1000)
    act(() => latest().open())
    const before = page.state()

    act(() => {
      old.open()
      old.message(msg(9))
      old.resync({ reason: 'gap', epoch: E, latestId: 9 })
      old.fail('connecting')
      old.fail('closed')
    })
    expect(page.state()).toBe(before)
    expect(page.http.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(sources()).toBe(2)
  })
})

describe('reconnecting (SPEC-001 D2)', () => {
  it('T006-S9 an error while CONNECTING is Reconnecting… and the page builds nothing; open is Live', async () => {
    const page = await loaded()
    act(() => latest().fail('connecting'))
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 0 })
    expect(sources()).toBe(1)
    expect(latest().closeCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().open())
    expect(page.state()).toMatchObject({ connection: 'live', attempt: 0 })
  })

  it('T006-S9 an error while CONNECTING during attempt 2 keeps that attempt; its CLOSED waits 4 s for attempt 3', async () => {
    const page = await live()
    act(() => latest().fail('closed'))
    await advance(1000)
    act(() => latest().fail('closed'))
    await advance(2000)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 2 })

    act(() => latest().fail('connecting'))
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 2 })
    act(() => latest().fail('closed'))
    expect(page.state().attempt).toBe(3)
    const count = sources()
    await advance(3999)
    expect(sources()).toBe(count)
    await advance(1)
    expect(sources()).toBe(count + 1)
  })

  it('T006-S10 attempts count from the moment each wait starts, resume from the last frame, and start over after open', async () => {
    const page = await live()
    act(() => latest().message(msg(4)))
    act(() => latest().fail('closed'))
    expect(latest().closeCalls).toBe(1)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 1 })

    await advance(1000)
    expect(sources()).toBe(2)
    expect(latest().after).toBe(`${E}.4`)
    act(() => latest().fail('closed'))
    expect(page.state().attempt).toBe(2)

    await advance(2000)
    expect(sources()).toBe(3)
    act(() => latest().fail('closed'))
    expect(page.state().attempt).toBe(3)

    await advance(4000)
    expect(sources()).toBe(4)
    expect(latest().after).toBe(`${E}.4`)
    act(() => latest().open())
    expect(page.state()).toMatchObject({ connection: 'live', attempt: 0 })

    act(() => latest().fail('closed'))
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 1 })
    await advance(999)
    expect(sources()).toBe(4)
    await advance(1)
    expect(sources()).toBe(5)
    expect(FakeEventSource.openOnes()).toHaveLength(1)
  })

  it('T006-S11 a drop at frame 9 resumes from E.9 though this tab posted 12; 10, 11 and 12 show once', async () => {
    const page = await live(listOf(E, ids(1, 8)))
    act(() => latest().message(msg(9)))
    act(() => latest().fail('closed'))

    const sent = await post(page, 'twelve')
    await answer(sent, reply(201, msg(12, E, 'twelve')))
    expect(page.state().resumeId).toBe(9)
    expect(idsOf(page)[0]).toBe(12)

    await advance(1000)
    expect(latest().after).toBe(`${E}.9`)
    act(() => {
      latest().open()
      latest().message(msg(10))
      latest().message(msg(11))
      latest().message(msg(12, E, 'twelve'))
    })
    expect(idsOf(page)).toEqual(ids(1, 12).reverse())
    expect(page.state().resumeId).toBe(12)
  })

  it('T006-B4 each wait after CLOSED is 1, 2, 4, 8 and 16 s: no stream at d−1 ms, one at d; Reconnect opens one at 0 ms', async () => {
    const page = await live()
    act(() => latest().fail('closed'))
    for (const [attempt, delay] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
      [4, 8000],
      [5, 16000],
    ] as const) {
      expect(backoffDelay(attempt)).toBe(delay)
      const count = sources()
      await advance(delay - 1)
      expect(sources(), `attempt ${attempt} at ${delay - 1} ms`).toBe(count)
      await advance(1)
      expect(sources(), `attempt ${attempt} at ${delay} ms`).toBe(count + 1)
      expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt })
      act(() => latest().fail('closed'))
    }
    expect(page.state().connection).toBe('offline')

    const count = sources()
    act(() => page.feed().reconnect())
    expect(sources()).toBe(count + 1)
  })

  it('T006-F11 the 5th failed attempt is Offline, with every stream closed and no timer left', async () => {
    const page = await live()
    await goOffline(page)
    expect(sources()).toBe(6)
    expect(FakeEventSource.openOnes()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(sources()).toBe(6)
  })

  it('T006-S12 Offline: Reconnect opens a stream at once as attempt 1, resuming from the held point', async () => {
    const page = await live()
    await goOffline(page)
    act(() => page.feed().reconnect())
    expect(sources()).toBe(7)
    expect(latest().after).toBe(`${E}.3`)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 1 })

    act(() => latest().fail('closed'))
    expect(page.state().attempt).toBe(2)
  })

  it('T006-S12 Reconnect does nothing unless Offline', async () => {
    const page = await live()
    act(() => page.feed().reconnect())
    act(() => latest().fail('closed'))
    act(() => page.feed().reconnect())
    expect(sources()).toBe(1)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 1 })
  })

  it('T006-S12 Offline: a 201 of the held epoch is shown and opens a stream at once', async () => {
    const page = await live()
    await goOffline(page)
    const sent = await post(page, 'back')
    await answer(sent, reply(201, msg(4, E, 'back')))
    expect(idsOf(page)).toEqual([4, 3, 2, 1])
    expect(sources()).toBe(7)
    expect(latest().after).toBe(`${E}.3`)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', attempt: 1 })
    expect(page.http.of('GET')).toHaveLength(1)
  })

  it('T006-S12 Offline: a reload that answers opens a stream at once', async () => {
    const page = await live()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(page.http.last())
    await goOffline(page)
    act(() => page.feed().retryReload())
    await answer(page.http.last(), reply(200, listOf(E, ids(1, 5))))
    expect(sources()).toBe(7)
    expect(latest().after).toBe(`${E}.5`)
    expect(page.state()).toMatchObject({ connection: 'reconnecting', reload: 'idle' })
  })

  it('T006-S14 Offline after a restart: a 201 with E2 drops the old run, reloads and opens after=E2.0; later after=E2.n', async () => {
    const page = await live(listOf(E, ids(1, 20)))
    await goOffline(page)
    const sent = await post(page, 'hi')
    await answer(sent, reply(201, msg(4, E2, 'hi')))

    expect(page.state().messages).toEqual([msg(4, E2, 'hi')])
    expect(page.state()).toMatchObject({ epoch: E2, connection: 'reconnecting', reload: 'pending' })
    expect(latest().after).toBe(`${E2}.0`)
    expect(page.http.of('GET')).toHaveLength(2)
    expect(page.http.last().url).toBe(LIST_URL)

    const count = sources()
    await answer(page.http.last(), reply(200, listOf(E2, ids(1, 5))))
    expect(sources()).toBe(count)
    expect(page.state()).toMatchObject({ resumeId: 5, reload: 'idle' })
    expect(idsOf(page)).toEqual([5, 4, 3, 2, 1])

    act(() => latest().fail('closed'))
    await advance(2000)
    expect(latest().after).toBe(`${E2}.5`)
  })
})

describe('sending (SPEC-001 D3, D4)', () => {
  it('T006-S4 posts the draft; the 201 clears it, shows the message once and leaves the resume point', async () => {
    const page = await live()
    const sent = await post(page, 'hello')
    expect(sent.init.method).toBe('POST')
    expect(sent.body).toEqual({ text: 'hello' })
    expect(page.state().composer).toEqual({ draft: 'hello', sending: true, error: null })

    await answer(sent, reply(201, msg(4, E, 'hello')))
    expect(page.state().composer).toEqual({ draft: '', sending: false, error: null })
    expect(page.state().resumeId).toBe(3)
    expect(page.http.of('GET')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    act(() => latest().message(msg(4, E, 'hello')))
    expect(idsOf(page)).toEqual([4, 3, 2, 1])
  })

  it('T006-F6 a second send while one is in flight makes no second POST', async () => {
    const page = await live()
    act(() => page.feed().edit('hi'))
    act(() => {
      page.feed().send()
      page.feed().send()
    })
    act(() => page.feed().send())
    expect(page.http.of('POST')).toHaveLength(1)
  })

  it('T006-F4 a blank draft or one over 280 code points is never posted', async () => {
    const page = await live()
    for (const draft of ['', '   ', 'a'.repeat(281)]) {
      act(() => page.feed().edit(draft))
      act(() => page.feed().send())
    }
    expect(page.http.of('POST')).toHaveLength(0)
  })

  it('T006-F3 a POST with no answer fails at 10 000 ms, not before, and keeps the draft', async () => {
    const page = await live()
    const sent = await post(page, 'slow')
    await advance(9_999)
    expect(page.state().composer.sending).toBe(true)
    await advance(1)
    expect(sent.signal.aborted).toBe(true)
    expect(page.state().composer).toEqual({
      draft: 'slow',
      sending: false,
      error: { kind: 'network' },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-F2 a 400 problem is held as the send error, and the draft kept', async () => {
    const page = await live()
    const sent = await post(page, 'x')
    const problem = { title: 'Invalid request', field: 'text', reason: 'too_long' }
    await answer(sent, reply(400, problem, 'application/problem+json'))
    expect(page.state().composer).toEqual({
      draft: 'x',
      sending: false,
      error: { kind: 'problem', status: 400, problem },
    })
  })

  it('T006-S13 a 201 while the load has failed adopts its epoch and opens no stream; Retry then shows it once', async () => {
    const page = mount()
    await failCall(page.http.call(0))
    const sent = await post(page, 'first')
    await answer(sent, reply(201, msg(3, E, 'first')))
    expect(page.state()).toMatchObject({ epoch: E, list: 'error', connection: 'none' })
    expect(idsOf(page)).toEqual([3])
    expect(sources()).toBe(0)
    expect(page.http.of('GET')).toHaveLength(1)

    act(() => page.feed().retry())
    await answer(page.http.last(), reply(200, listOf(E, [1, 2, 3])))
    expect(idsOf(page)).toEqual([3, 2, 1])
    expect(latest().after).toBe(`${E}.3`)
  })

  it('T006-S13 a 201 answered after the server read the Retry list stays shown, once, through the replay', async () => {
    const page = mount()
    await failCall(page.http.call(0))
    const sent = await post(page, 'late')
    act(() => page.feed().retry())
    const get = page.http.last()

    await answer(sent, reply(201, msg(4, E, 'late')))
    await answer(get, reply(200, listOf(E, [1, 2, 3])))
    expect(idsOf(page)).toEqual([4, 3, 2, 1])
    expect(latest().after).toBe(`${E}.3`)

    act(() => {
      latest().open()
      latest().message(msg(4, E, 'late'))
    })
    expect(idsOf(page)).toEqual([4, 3, 2, 1])
  })

  it('T006-S14 a 201 of another epoch while live reloads the list but opens no second stream', async () => {
    const page = await live(listOf(E, ids(1, 5)))
    const sent = await post(page, 'new run')
    await answer(sent, reply(201, msg(1, E2, 'new run')))
    expect(page.state()).toMatchObject({ epoch: E2, resumeId: 0, reload: 'pending' })
    expect(page.http.of('GET')).toHaveLength(2)
    expect(sources()).toBe(1)
  })
})

describe('unmounting (SPEC-001 D5)', () => {
  it('T006-L1 unmounting while reconnecting closes the stream and leaves no timer', async () => {
    const page = await live()
    act(() => latest().fail('closed'))
    await advance(1000)
    const retrying = latest()
    act(() => retrying.fail('connecting'))
    expect(page.state().connection).toBe('reconnecting')

    page.view.unmount()
    expect(retrying.closeCalls).toBe(1)
    expect(FakeEventSource.openOnes()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('T006-L1 unmounting during the wait for an attempt clears it: no stream is built later', async () => {
    const page = await live()
    act(() => latest().fail('closed'))
    expect(vi.getTimerCount()).toBe(1)
    page.view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(1000)
    expect(sources()).toBe(1)
  })

  it('T006-L1 unmounting aborts a pending reload and POST, ignores their answers, and leaves no timer', async () => {
    const page = await live(listOf(E, [1, 2, 3]), { ignoreAbort: true })
    act(() => latest().resync(null))
    const reload = page.http.last()
    const sent = await post(page, 'bye')
    const before = page.state()

    page.view.unmount()
    expect(reload.signal.aborted).toBe(true)
    expect(sent.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    const calls = page.http.calls.length
    await answer(reload, reply(200, listOf(E2, [1])))
    // A 201 of another epoch would start a reload if it were applied.
    await answer(sent, reply(201, msg(4, E2)))
    expect(page.state()).toBe(before)
    expect(page.http.calls).toHaveLength(calls)
    expect(vi.getTimerCount()).toBe(0)
    expect(sources()).toBe(1)
  })

  it('T006-L2 unmounting while the first GET is pending aborts it, and its late answer builds no stream', async () => {
    const page = mount({ ignoreAbort: true })
    const get = page.http.call(0)
    page.view.unmount()
    expect(get.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    await answer(get, reply(200, listOf(E, [1])))
    expect(sources()).toBe(0)
  })

  it('T006-L2 an action after unmounting does nothing', async () => {
    const page = await live()
    await goOffline(page)
    const feed = page.feed()
    page.view.unmount()
    act(() => {
      feed.edit('late')
      feed.send()
      feed.retry()
      feed.retryReload()
      feed.reconnect()
    })
    expect(page.http.calls).toHaveLength(1)
    expect(sources()).toBe(6)
  })
})
