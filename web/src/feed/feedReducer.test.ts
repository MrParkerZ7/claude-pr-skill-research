import { describe, expect, it } from 'vitest'
import type { Message } from '../api/messages'
import { E, E2, ids, listOf, msg } from '../test/fixtures'
import {
  adoptEpoch,
  canSend,
  codePoints,
  feedReducer,
  initialFeedState,
  mergeMessages,
  type FeedAction,
  type FeedState,
} from './feedReducer'

const run = (state: FeedState, ...actions: FeedAction[]): FeedState =>
  actions.reduce(feedReducer, state)

/** A page whose first list load gave these ids of `epoch`. */
const loadedWith = (epoch: string, messageIds: number[], latestId?: number): FeedState =>
  run(initialFeedState(), { type: 'loaded', list: listOf(epoch, messageIds, latestId) })

const idsOf = (state: FeedState) => state.messages.map((m) => m.id)
const received = (message: Message): FeedAction => ({ type: 'received', message })

describe('loading (SPEC-001 D1)', () => {
  it('T006-S1 starts loading with nothing held, and a load adopts the epoch and its latestId', () => {
    const start = initialFeedState()
    expect(start).toMatchObject({ list: 'loading', connection: 'none', epoch: null, resumeId: 0 })

    const state = loadedWith(E, [1, 2, 3])
    expect(state).toMatchObject({ list: 'ready', reload: 'idle', epoch: E, resumeId: 3 })
    expect(idsOf(state)).toEqual([3, 2, 1])
  })

  it('T006-F1 a failed load is an error, and Retry returns it to loading', () => {
    const failed = run(initialFeedState(), { type: 'loadFailed' })
    expect(failed.list).toBe('error')
    expect(run(failed, { type: 'retry' }).list).toBe('loading')
  })
})

describe('frames (SPEC-001 D5)', () => {
  it('T006-S3 a frame goes on top and raises the resume point to its id', () => {
    const state = run(loadedWith(E, [1, 2]), received(msg(3, E, 'a\nb')))
    expect(state.messages[0]).toEqual(msg(3, E, 'a\nb'))
    expect(state.resumeId).toBe(3)
  })

  it('T006-F8 a frame of another epoch changes nothing', () => {
    const state = loadedWith(E, [1, 2])
    expect(run(state, received(msg(3, E2)))).toBe(state)
  })

  it('T006-B3 the same id twice is held once, and an older id arriving late takes its place in id order', () => {
    const state = run(loadedWith(E, [1, 2]), received(msg(5)), received(msg(5)), received(msg(4)))
    expect(idsOf(state)).toEqual([5, 4, 2, 1])
    expect(state.resumeId).toBe(5)
  })

  it('T006-B2 100 held and 1 new keeps 100, dropping the lowest id', () => {
    const state = run(loadedWith(E, ids(1, 100)), received(msg(101)))
    expect(state.messages).toHaveLength(100)
    expect(idsOf(state)[0]).toBe(101)
    expect(idsOf(state).at(-1)).toBe(2)
  })
})

describe('resync (SPEC-001 D5)', () => {
  it('T006-S6 a gap resync then a reload keeps what streamed in meanwhile, each once', () => {
    const state = run(loadedWith(E, ids(1, 8)), {
      type: 'resync',
      resync: { reason: 'gap', epoch: E, latestId: 10 },
    })
    expect(state).toMatchObject({ reload: 'pending', resumeId: 10 })

    const during = run(state, received(msg(11)))
    const after = run(during, { type: 'resynced', list: listOf(E, ids(1, 10)) })
    expect(idsOf(after)).toEqual([11, ...ids(1, 10).reverse()])
    expect(after).toMatchObject({ reload: 'idle', resumeId: 11 })
  })

  it('T006-S6 the reload replaces the held messages at or below its latestId', () => {
    // 3 was held but is not in the reload (it was evicted meanwhile): it goes. 9 is above latestId: it stays.
    const held = run(loadedWith(E, [3, 4]), received(msg(9)), {
      type: 'resync',
      resync: { reason: 'gap', epoch: E, latestId: 8 },
    })
    const after = run(held, { type: 'resynced', list: listOf(E, [4, 5, 8]) })
    expect(idsOf(after)).toEqual([9, 8, 5, 4])
  })

  it('T006-S7 a restart resync adopts the new epoch, drops the old run, and ignores its late frames', () => {
    const held = loadedWith(E, ids(1, 50))
    expect(held.resumeId).toBe(50)

    const state = run(held, {
      type: 'resync',
      resync: { reason: 'restart', epoch: E2, latestId: 3 },
    })
    expect(state).toMatchObject({ epoch: E2, resumeId: 3, reload: 'pending', messages: [] })
    expect(run(state, received(msg(51)))).toBe(state)

    const reloaded = run(state, { type: 'resynced', list: listOf(E2, [1, 2, 3]) })
    expect(idsOf(reloaded)).toEqual([3, 2, 1])
    expect(reloaded.messages.every((m) => m.epoch === E2)).toBe(true)
  })

  it('T006-S8 an ahead resync lowers the resume point to its latestId', () => {
    const state = run(loadedWith(E, ids(1, 9)), {
      type: 'resync',
      resync: { reason: 'ahead', epoch: E, latestId: 5 },
    })
    expect(state.resumeId).toBe(5)
    expect(idsOf(state)).toEqual(ids(1, 9).reverse())
  })

  it('T006-F8 a resync with invalid data reloads and leaves the resume point', () => {
    const held = loadedWith(E, ids(1, 9))
    const state = run(held, { type: 'resync', resync: null })
    expect(state).toEqual({ ...held, reload: 'pending' })
  })

  it('T006-S14 a reload of another epoch adopts it', () => {
    const state = run(loadedWith(E, [1, 2]), { type: 'resync', resync: null })
    const after = run(state, { type: 'resynced', list: listOf(E2, [1]) })
    expect(after).toMatchObject({ epoch: E2, resumeId: 1, reload: 'idle' })
    expect(after.messages).toEqual([msg(1, E2)])
  })

  it('T006-F9 a failed reload keeps the list and the pill; Retry returns it to pending', () => {
    const live = run(loadedWith(E, [1, 2]), { type: 'connection', state: 'live', attempt: 0 })
    const failed = run(live, { type: 'resync', resync: null }, { type: 'reloadFailed' })
    expect(failed).toMatchObject({ reload: 'error', connection: 'live' })
    expect(failed.messages).toBe(live.messages)
    expect(run(failed, { type: 'reloadRetry' }).reload).toBe('pending')
  })
})

describe('adoptEpoch (SPEC-001 D5)', () => {
  it('T006-S7 drops every message of another epoch and sets the resume point, even lower', () => {
    const state: FeedState = { ...initialFeedState(), epoch: E, resumeId: 50, messages: [msg(50)] }
    expect(adoptEpoch(state, E2, 3)).toEqual({ ...state, epoch: E2, resumeId: 3, messages: [] })
  })
})

describe('the composer (SPEC-001 D3, D4)', () => {
  it('T006-S4 a 201 within the held epoch is shown once with its echo, and never moves the resume point', () => {
    const sending = run(
      loadedWith(E, [1, 2]),
      { type: 'edited', draft: 'hello' },
      { type: 'sendStarted' },
    )
    expect(sending.composer).toEqual({ draft: 'hello', sending: true, error: null })

    const sent = run(sending, { type: 'sent', message: msg(3, E, 'hello') })
    expect(sent.composer).toEqual({ draft: '', sending: false, error: null })
    expect(sent.resumeId).toBe(2)
    expect(sent.reload).toBe('idle')
    expect(idsOf(sent)).toEqual([3, 2, 1])

    const echoed = run(sent, received(msg(3, E, 'hello')))
    expect(idsOf(echoed)).toEqual([3, 2, 1])
    expect(echoed.resumeId).toBe(3)
  })

  it('T006-F2 a failed send keeps the draft and holds the error until the next edit', () => {
    const error = { kind: 'http', status: 418 } as const
    const failed = run(
      initialFeedState(),
      { type: 'edited', draft: 'hello' },
      { type: 'sendStarted' },
      { type: 'sendFailed', error },
    )
    expect(failed.composer).toEqual({ draft: 'hello', sending: false, error })
    expect(run(failed, { type: 'edited', draft: 'hello!' }).composer.error).toBeNull()
    expect(run(failed, { type: 'sendStarted' }).composer.error).toBeNull()
  })

  it('T006-S13 a 201 while the load has failed adopts its epoch; the Retry load then holds it once', () => {
    const failed = run(initialFeedState(), { type: 'loadFailed' })
    const sent = run(failed, { type: 'sent', message: msg(3) })
    expect(sent).toMatchObject({ epoch: E, resumeId: 0, reload: 'idle', list: 'error' })
    expect(idsOf(sent)).toEqual([3])

    const loaded = run(sent, { type: 'retry' }, { type: 'loaded', list: listOf(E, [1, 2, 3]) })
    expect(idsOf(loaded)).toEqual([3, 2, 1])
    expect(loaded.resumeId).toBe(3)
  })

  it('T006-S14 a 201 of another epoch drops the old run, shows the message and asks for a reload', () => {
    const offline = run(loadedWith(E, ids(1, 20)), { type: 'connection', state: 'offline' })
    const sent = run(offline, { type: 'sent', message: msg(4, E2) })
    expect(sent).toMatchObject({ epoch: E2, resumeId: 0, reload: 'pending' })
    expect(sent.messages).toEqual([msg(4, E2)])

    const reloaded = run(sent, { type: 'resynced', list: listOf(E2, [1, 2, 3, 4], 4) })
    expect(reloaded.resumeId).toBe(4)
    expect(idsOf(reloaded)).toEqual([4, 3, 2, 1])
  })

  it('T006-B1 counts code points of the trimmed text: 0, 1, 280 and 281, emoji too', () => {
    const emoji = String.fromCodePoint(0x1f600)
    expect([codePoints(''), codePoints('a'), codePoints(emoji.repeat(280))]).toEqual([0, 1, 280])
    expect(codePoints(` ${'a'.repeat(281)} `)).toBe(281)
    expect(['', 'a', emoji.repeat(280), 'a'.repeat(280), 'a'.repeat(281)].map(canSend)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it('T006-F4 a draft of only spaces and line breaks cannot be sent', () => {
    expect(codePoints('   \n\t ')).toBe(0)
    expect(canSend('   \n\t ')).toBe(false)
  })
})

describe('connection (SPEC-001 D2)', () => {
  it('T006-S9 records the state, and keeps the attempt unless one is given', () => {
    const waiting = run(initialFeedState(), {
      type: 'connection',
      state: 'reconnecting',
      attempt: 2,
    })
    expect(waiting).toMatchObject({ connection: 'reconnecting', attempt: 2 })
    expect(run(waiting, { type: 'connection', state: 'reconnecting' }).attempt).toBe(2)
    expect(run(waiting, { type: 'connection', state: 'live', attempt: 0 }).attempt).toBe(0)
  })
})

describe('mergeMessages', () => {
  it('T006-P1 the reducer merges 100 into 100: by id, once, newest first, the newest 100 kept (50 ms backstop)', () => {
    const held = loadedWith(E, ids(1, 100))
    const action: FeedAction = { type: 'loaded', list: listOf(E, ids(51, 150)) }
    feedReducer(held, action) // warm-up

    const started = performance.now()
    const merged = feedReducer(held, action)
    const elapsed = performance.now() - started

    expect(idsOf(merged)).toEqual(ids(51, 150).reverse())
    expect(merged.resumeId).toBe(150)
    expect(mergeMessages(held.messages, merged.messages)).toEqual(merged.messages)
    expect(elapsed).toBeLessThan(50)
  })
})
