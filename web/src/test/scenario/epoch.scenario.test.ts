// T-014: scenario cases for SPEC-001 D5 (soft-test-scenario), through the hook with a scripted fetch and EventSource.
// A case id comes first in each name; the cases are the ones the unit and page suites of T-006 do not already prove.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_URL } from '../../api/messages'
import type { FeedState } from '../../feed/feedReducer'
import { useMessageFeed } from '../../feed/useMessageFeed'
import { FakeEventSource } from '../FakeEventSource'
import {
  E,
  E2,
  advance,
  answer,
  failCall,
  fakeFetch,
  ids,
  listOf,
  msg,
  reply,
  type FetchCall,
} from '../fixtures'

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

function mount(ignoreAbort = false) {
  const http = fakeFetch({ ignoreAbort })
  const view = renderHook(() => useMessageFeed({ fetch: http.fn, EventSource: FakeEventSource }))
  return {
    http,
    view,
    state: (): FeedState => view.result.current.state,
    feed: () => view.result.current,
  }
}

type Page = ReturnType<typeof mount>

/** First GET answered with E ids 1–3, the stream opened. */
async function live(ignoreAbort = false): Promise<Page> {
  const page = mount(ignoreAbort)
  await answer(page.http.call(0), reply(200, listOf(E, [1, 2, 3])))
  act(() => FakeEventSource.latest().open())
  return page
}

const latest = () => FakeEventSource.latest()
const sources = () => FakeEventSource.instances.length
const idsOf = (page: Page) => page.state().messages.map((m) => m.id)
const gets = (page: Page) => page.http.of('GET')

/** Edits and sends; returns the POST call, unanswered. */
function post(page: Page, text: string): FetchCall {
  act(() => page.feed().edit(text))
  act(() => page.feed().send())
  return page.http.last()
}

/** mulberry32: a small seeded PRNG; the same seed always gives the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('T-014 SPEC-001 D5 scenario cases', () => {
  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5a-D1 a Retry list of another epoch than the one a 201 adopted', async () => {
    const page = mount()
    await failCall(page.http.call(0))
    expect(page.state().list).toBe('error')

    await answer(post(page, 'a'), reply(201, msg(3, E, 'a')))
    expect(page.state()).toMatchObject({ epoch: E, resumeId: 0 })
    expect(idsOf(page)).toEqual([3])
    expect(sources()).toBe(0)

    act(() => page.feed().retry())
    expect(gets(page)).toHaveLength(2)

    await answer(page.http.last(), reply(200, listOf(E2, [1, 2])))
    expect(page.state()).toMatchObject({ epoch: E2, list: 'ready', resumeId: 2 })
    expect(page.state().messages).toEqual([msg(2, E2), msg(1, E2)])
    expect(sources()).toBe(1)
    expect(latest().after).toBe('89abcdef.2')
  })

  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5a-D2 a 201 of another epoch while the list is not loaded', async () => {
    const page = mount()
    await failCall(page.http.call(0))
    await answer(post(page, 'a'), reply(201, msg(3, E, 'a')))

    await answer(post(page, 'b'), reply(201, msg(1, E2, 'b')))
    expect(page.state()).toMatchObject({ epoch: E2, resumeId: 0, list: 'error', reload: 'idle' })
    expect(page.state().messages).toEqual([msg(1, E2, 'b')])
    expect(page.state().composer).toEqual({ draft: '', sending: false, error: null })
    expect(gets(page)).toHaveLength(1)
    expect(sources()).toBe(0)

    act(() => page.feed().retry())
    await answer(
      page.http.last(),
      reply(200, { epoch: E2, messages: [msg(1, E2, 'b')], latestId: 1 }),
    )
    expect(page.state()).toMatchObject({ list: 'ready', resumeId: 1 })
    expect(idsOf(page)).toEqual([1])
    expect(sources()).toBe(1)
    expect(latest().after).toBe('89abcdef.1')
  })

  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5a-T1 reload error, then a 201 of another epoch starts a reload', async () => {
    const page = await live()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(page.http.last())
    expect(page.state().reload).toBe('error')

    await answer(post(page, 'x'), reply(201, msg(1, E2, 'x')))
    expect(page.state()).toMatchObject({ reload: 'pending', epoch: E2, resumeId: 0 })
    expect(page.state().messages).toEqual([msg(1, E2, 'x')])
    expect(gets(page)).toHaveLength(3)
    expect(page.http.last().url).toBe(LIST_URL)

    await answer(
      page.http.last(),
      reply(200, { epoch: E2, messages: [msg(1, E2, 'x')], latestId: 1 }),
    )
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 1 })
    expect(idsOf(page)).toEqual([1])
    expect(sources()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5c-T1 reload error, then a newer resync starts a reload', async () => {
    const page = await live()
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    await failCall(page.http.last())
    expect(page.state()).toMatchObject({ reload: 'error', resumeId: 5 })

    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 7 }))
    expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 7 })
    expect(gets(page)).toHaveLength(3)
    expect(page.http.last().url).toBe(LIST_URL)

    await answer(page.http.last(), reply(200, listOf(E, ids(1, 7))))
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 7 })
    expect(idsOf(page)).toEqual([7, 6, 5, 4, 3, 2, 1])
    expect(vi.getTimerCount()).toBe(0)
  })

  type Result = 'ok' | 'fail'
  const RACES: [string, Result, 'before' | 'after', Result][] = [
    ['SC-messages-RD5d-D1', 'ok', 'after', 'ok'],
    ['SC-messages-RD5d-D2', 'fail', 'after', 'ok'],
    ['SC-messages-RD5d-D3', 'ok', 'before', 'fail'],
    ['SC-messages-RD5d-D4', 'ok', 'after', 'fail'],
    ['SC-messages-RD5d-D5', 'fail', 'before', 'fail'],
    ['SC-messages-RD5d-D6', 'fail', 'after', 'fail'],
  ]

  // Rows D1 and D2 are Optional-Success cells; rows D3 to D6 are Optional-Fail cells.
  // serves-spec: SPEC-001 #D5 · Optional-Success
  it.each(RACES)(
    '%s the older reload answers %s %s the newer, which answers %s',
    async (_id, older, when, newer) => {
      const page = await live(true)
      act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 9 }))
      const olderCall = page.http.last()
      act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 6 }))
      const newerCall = page.http.last()
      expect(olderCall.signal.aborted).toBe(true)
      expect(newerCall.signal.aborted).toBe(false)
      expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 6 })

      const settleOlder = () =>
        older === 'ok' ? answer(olderCall, reply(200, listOf(E, ids(1, 9)))) : failCall(olderCall)
      const settleNewer = () =>
        newer === 'ok' ? answer(newerCall, reply(200, listOf(E, ids(1, 6)))) : failCall(newerCall)

      if (when === 'before') {
        await settleOlder()
        expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 6 })
        expect(idsOf(page)).toEqual([3, 2, 1])
        await settleNewer()
      } else {
        await settleNewer()
        const before = page.state()
        await settleOlder()
        expect(page.state()).toBe(before)
      }

      if (newer === 'ok') {
        expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 6 })
        expect(idsOf(page)).toEqual(ids(1, 6).reverse())
      } else {
        expect(page.state()).toMatchObject({ reload: 'error', resumeId: 6 })
        expect(idsOf(page)).toEqual([3, 2, 1])
      }
      expect(gets(page)).toHaveLength(3)
      expect(vi.getTimerCount()).toBe(0)
      expect(sources()).toBe(1)
    },
  )

  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5d-T1 a 201 of another epoch aborts a pending resync reload; the stale list is ignored', async () => {
    const page = await live(true)
    act(() => latest().resync({ reason: 'gap', epoch: E, latestId: 5 }))
    const older = page.http.last()
    expect(page.state()).toMatchObject({ reload: 'pending', resumeId: 5 })

    await answer(post(page, 'new run'), reply(201, msg(1, E2, 'new run')))
    const newer = page.http.last()
    expect(older.signal.aborted).toBe(true)
    expect(gets(page)).toHaveLength(3)
    expect(newer.url).toBe(LIST_URL)
    expect(page.state()).toMatchObject({ epoch: E2, resumeId: 0, reload: 'pending' })
    expect(page.state().messages).toEqual([msg(1, E2, 'new run')])

    const before = page.state()
    await answer(older, reply(200, listOf(E, ids(1, 5))))
    expect(page.state()).toBe(before)

    await answer(newer, reply(200, { epoch: E2, messages: [msg(1, E2, 'new run')], latestId: 1 }))
    expect(page.state()).toMatchObject({ reload: 'idle', epoch: E2, resumeId: 1 })
    expect(page.state().messages).toEqual([msg(1, E2, 'new run')])
    expect(sources()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D5 · Optional-Fail
  it('SC-messages-RD5h-T1 the reload a 201 started fails; Retry recovers', async () => {
    const page = await live()
    await answer(post(page, 'x'), reply(201, msg(1, E2, 'x')))
    expect(gets(page)).toHaveLength(2)
    expect(page.state().reload).toBe('pending')

    await failCall(page.http.last())
    expect(page.state()).toMatchObject({
      reload: 'error',
      epoch: E2,
      resumeId: 0,
      connection: 'live',
    })
    expect(page.state().messages).toEqual([msg(1, E2, 'x')])
    expect(sources()).toBe(1)

    act(() => page.feed().retryReload())
    expect(page.state().reload).toBe('pending')
    expect(gets(page)).toHaveLength(3)
    expect(page.http.last().url).toBe(LIST_URL)

    await answer(
      page.http.last(),
      reply(200, { epoch: E2, messages: [msg(1, E2, 'x')], latestId: 1 }),
    )
    expect(page.state()).toMatchObject({ reload: 'idle', resumeId: 1 })
    expect(idsOf(page)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  // serves-spec: SPEC-001 #D5 · Optional-Success
  it('SC-messages-RD5f-OS1 frames in any seeded order, with duplicates and 201s, keep the held list and the resume point', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      FakeEventSource.reset()
      const rng = mulberry32(seed)
      const page = await live()
      const frames = ids(4, 130)
      for (let k = 0; k < 25; k += 1) frames.push(4 + Math.floor(rng() * 127))
      for (let i = frames.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1))
        const t = frames[i] as number
        frames[i] = frames[j] as number
        frames[j] = t
      }
      const postAt = new Set<number>()
      while (postAt.size < 5) postAt.add(Math.floor(rng() * frames.length))
      const held = new Set([1, 2, 3])
      let maxFrame = 3
      const check = (step: string) => {
        const expected = [...held].sort((a, b) => b - a).slice(0, 100)
        expect(idsOf(page), `seed ${seed} ${step}`).toEqual(expected)
        expect(page.state().resumeId, `seed ${seed} ${step}`).toBe(maxFrame)
        expect(
          page.state().messages.every((m) => m.epoch === E),
          `seed ${seed} ${step}`,
        ).toBe(true)
      }
      for (const [i, id] of frames.entries()) {
        if (postAt.has(i)) {
          const posted = 4 + Math.floor(rng() * 127)
          await answer(post(page, `p${i}`), reply(201, msg(posted)))
          held.add(posted)
          check(`201 ${posted} before step ${i}`)
        }
        act(() => latest().message(msg(id)))
        held.add(id)
        maxFrame = Math.max(maxFrame, id)
        check(`frame ${id} at step ${i}`)
      }
      expect(idsOf(page)).toEqual(ids(31, 130).reverse())
      expect(page.state().resumeId).toBe(130)
      act(() => latest().fail('closed'))
      await advance(1000)
      expect(latest().after).toBe(`${E}.130`)
      page.view.unmount()
    }
  }, 30_000)
})
