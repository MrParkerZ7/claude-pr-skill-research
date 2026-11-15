import { describe, expect, it, vi } from 'vitest'
import { contract, E, msg, reply, sseFrames } from '../test/fixtures'
import {
  LIST_URL,
  fetchMessages,
  isMessage,
  isMessageList,
  isResync,
  parseFrameId,
  parseMessageFrame,
  parseResync,
  postMessage,
  streamUrl,
  type FetchFn,
} from './messages'

const signal = new AbortController().signal
const answering = (response: Response | Error) =>
  vi.fn<FetchFn>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  )

describe('contract fixtures', () => {
  it('T006-K1 message.json is a message, message-list.json a list, and the stream sample frames merge', () => {
    expect(isMessage(contract.message)).toBe(true)
    expect(isMessageList(contract.messageList)).toBe(true)

    const frames = sseFrames(contract.streamSample)
    expect(frames.map((f) => [f.event, f.id])).toEqual([
      ['message', '0123abcd.1'],
      ['message', '0123abcd.2'],
    ])
    const messages = frames.map((f) => parseMessageFrame(f.data, f.id))
    expect(messages.map((m) => m?.id)).toEqual([1, 2])
    expect(messages.map((m) => m?.text)).toEqual(['a', 'b'])
  })
})

describe('isMessage', () => {
  it('T006-F8 accepts only a message of the A1 shape', () => {
    expect(isMessage(msg(1))).toBe(true)
    expect(isMessage({ ...msg(1), extra: true })).toBe(true)
    for (const bad of [
      null,
      'hi',
      [msg(1)],
      { ...msg(1), id: 0 },
      { ...msg(1), id: 1.5 },
      { ...msg(1), id: '1' },
      { ...msg(1), id: 2 ** 53 },
      { ...msg(1), epoch: '0123ABCD' },
      { ...msg(1), epoch: '0123abc' },
      { ...msg(1), epoch: '0123abcde' },
      { ...msg(1), text: 5 },
      { ...msg(1), createdAt: 5 },
      { ...msg(1), createdAt: 'yesterday' },
    ]) {
      expect(isMessage(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('isMessageList', () => {
  it('T006-F9 accepts only a list whose messages are all of its epoch', () => {
    const list = { epoch: E, messages: [msg(2), msg(1)], latestId: 2 }
    expect(isMessageList(list)).toBe(true)
    expect(isMessageList({ epoch: E, messages: [], latestId: 0 })).toBe(true)
    for (const bad of [
      null,
      [list],
      { ...list, epoch: 'nope' },
      { ...list, latestId: -1 },
      { ...list, latestId: 1.5 },
      { ...list, latestId: '2' },
      { ...list, messages: 'none' },
      { ...list, messages: [msg(2), { id: 1 }] },
      { ...list, messages: [msg(2, '89abcdef')] },
    ]) {
      expect(isMessageList(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('isResync and parseResync', () => {
  it('T006-F8 reads a resync of the C5 shape, and nothing else', () => {
    const resync = { reason: 'gap', epoch: E, latestId: 10 }
    expect(isResync(resync)).toBe(true)
    expect(isResync({ ...resync, latestId: 0 })).toBe(true)
    for (const bad of [
      null,
      [resync],
      { ...resync, reason: 1 },
      { ...resync, epoch: 'ffff' },
      { ...resync, latestId: -1 },
      { ...resync, latestId: '10' },
    ]) {
      expect(isResync(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(parseResync(JSON.stringify(resync))).toEqual(resync)
    expect(parseResync('{not json')).toBeNull()
    expect(parseResync('{"reason":"gap"}')).toBeNull()
  })
})

describe('parseFrameId', () => {
  it('T006-F8 reads <epoch>.<seq> and refuses anything else', () => {
    expect(parseFrameId('0123abcd.42')).toEqual({ epoch: '0123abcd', seq: 42 })
    expect(parseFrameId('0123abcd.0')).toEqual({ epoch: '0123abcd', seq: 0 })
    expect(parseFrameId('0123abcd.9007199254740991')).toEqual({
      epoch: '0123abcd',
      seq: Number.MAX_SAFE_INTEGER,
    })
    for (const bad of [
      '',
      '42',
      '0123abcd',
      '0123abcd.',
      '0123ABCD.1',
      '0123abc.1',
      '0123abcd.01',
      '0123abcd.-1',
      '0123abcd.1x',
      'x0123abcd.1',
      '0123abcd.9007199254740992',
    ]) {
      expect(parseFrameId(bad), bad).toBeNull()
    }
  })
})

describe('parseMessageFrame', () => {
  it('T006-F8 ignores data that is not JSON, not a message, or not named by the frame id', () => {
    const data = JSON.stringify(msg(9))
    expect(parseMessageFrame(data, `${E}.9`)).toEqual(msg(9))
    expect(parseMessageFrame('not json', `${E}.9`)).toBeNull()
    expect(parseMessageFrame('{"id":9}', `${E}.9`)).toBeNull()
    expect(parseMessageFrame(data, '')).toBeNull()
    expect(parseMessageFrame(data, `${E}.8`)).toBeNull()
    expect(parseMessageFrame(data, '89abcdef.9')).toBeNull()
  })
})

describe('streamUrl', () => {
  it('T006-S1 resumes from <epoch>.<resumeId>', () => {
    expect(streamUrl(E, 3)).toBe('/api/messages/stream?after=0123abcd.3')
  })
})

describe('fetchMessages', () => {
  it('T006-S1 asks for limit=100 with the given signal, and reads the list', async () => {
    const list = { epoch: E, messages: [msg(1)], latestId: 1 }
    const fetchFn = answering(reply(200, list))

    expect(await fetchMessages(fetchFn, signal)).toEqual({ ok: true, value: list })
    expect(LIST_URL).toBe('/api/messages?limit=100')
    expect(fetchFn).toHaveBeenCalledWith('/api/messages?limit=100', { signal })
  })

  it('T006-F1 turns a rejection, an unreadable body, a bad shape and an error status into errors', async () => {
    expect(await fetchMessages(answering(new TypeError('Failed to fetch')), signal)).toEqual({
      ok: false,
      error: { kind: 'network' },
    })
    expect(await fetchMessages(answering(reply(200, '<html>')), signal)).toEqual({
      ok: false,
      error: { kind: 'network' },
    })
    expect(await fetchMessages(answering(reply(200, { epoch: E })), signal)).toEqual({
      ok: false,
      error: { kind: 'http', status: 200 },
    })
    expect(await fetchMessages(answering(reply(500)), signal)).toEqual({
      ok: false,
      error: { kind: 'http', status: 500 },
    })
  })
})

describe('postMessage', () => {
  it('T006-S4 posts {"text"} as JSON with the given signal, and reads the 201', async () => {
    const fetchFn = answering(reply(201, msg(7, E, 'hello')))

    expect(await postMessage(fetchFn, 'hello', signal)).toEqual({
      ok: true,
      value: msg(7, E, 'hello'),
    })
    expect(fetchFn).toHaveBeenCalledWith('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"text":"hello"}',
      signal,
    })
  })

  it('T006-F7 hands a problem answer back as a problem error', async () => {
    const problem = contract.problem as object
    const result = await postMessage(
      answering(reply(400, problem, 'application/problem+json')),
      ' ',
      signal,
    )
    expect(result).toEqual({ ok: false, error: { kind: 'problem', status: 400, problem } })
  })
})
