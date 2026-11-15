/// <reference types="node" />
// Shared test data: the contract fixtures of contracts/messages/, message builders, a scripted fetch and a flush.
import { readFileSync } from 'node:fs'
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { Message, MessageList } from '../api/messages'

// The base goes through a variable: Vite rewrites `new URL('…', import.meta.url)` written out in full into an asset
// import, which it then refuses for a file outside web/.
const here = import.meta.url
const contractFile = (name: string) =>
  readFileSync(new URL(`../../../contracts/messages/${name}`, here), 'utf8')

/** The shared truth the API's own tests also read. */
export const contract = {
  message: JSON.parse(contractFile('message.json')) as unknown,
  messageList: JSON.parse(contractFile('message-list.json')) as unknown,
  problem: JSON.parse(contractFile('problem-invalid-request.json')) as unknown,
  streamSample: contractFile('stream-sample.txt'),
}

export interface Frame {
  readonly id: string
  readonly event: string
  readonly data: string
}

/** The frames of a `text/event-stream` text that carry data, with their `id` and `event` fields. */
export function sseFrames(text: string): Frame[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const fields = new Map<string, string>()
      for (const line of block.split(/\r?\n/)) {
        const colon = line.indexOf(':')
        if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1))
      }
      return {
        id: fields.get('id') ?? '',
        event: fields.get('event') ?? 'message',
        data: fields.get('data') ?? '',
      }
    })
    .filter((frame) => frame.data !== '')
}

export const E = '0123abcd'
export const E2 = '89abcdef'
export const CREATED_AT = '2026-11-06T10:15:30.123Z'

export const msg = (id: number, epoch = E, text = `m${id}`): Message => ({
  id,
  epoch,
  text,
  createdAt: CREATED_AT,
})

/** The ids from..to inclusive. */
export const ids = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** A list response holding these ids, newest first; `latestId` is the newest id unless given. */
export const listOf = (epoch: string, messageIds: number[], latestId?: number): MessageList => {
  const sorted = [...messageIds].sort((a, b) => b - a)
  return {
    epoch,
    messages: sorted.map((id) => msg(id, epoch)),
    latestId: latestId ?? sorted[0] ?? 0,
  }
}

/**
 * A response object the page can read. `body` is returned by `json()` (a string is parsed, so it may throw); with no
 * body `json()` rejects, as for an empty response.
 */
export function reply(status: number, body?: unknown, contentType?: string): Response {
  const type = contentType ?? (body === undefined ? undefined : 'application/json')
  const json = () =>
    body === undefined
      ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
      : typeof body === 'string'
        ? Promise.resolve().then(() => JSON.parse(body) as unknown)
        : Promise.resolve(structuredClone(body))
  return {
    ok: status >= 200 && status <= 299,
    status,
    headers: new Headers(type === undefined ? {} : { 'content-type': type }),
    json,
  } as unknown as Response
}

export interface FetchCall {
  readonly url: string
  readonly init: RequestInit
  readonly signal: AbortSignal
  /** The parsed JSON request body. */
  readonly body: unknown
  respond(response: Response): void
  /** A network failure: fetch rejects with a TypeError. */
  fail(): void
}

/**
 * A fetch whose every call waits until the test answers it. An abort rejects it, as the browser's does, unless
 * `ignoreAbort` is set: then a late answer still arrives, to prove the page ignores it.
 */
export function fakeFetch({ ignoreAbort = false } = {}) {
  const calls: FetchCall[] = []
  const fn = vi.fn(
    (input: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal ?? new AbortController().signal
        signal.addEventListener('abort', () => {
          if (!ignoreAbort) reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        calls.push({
          url: String(input),
          init,
          signal,
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          respond: resolve,
          fail: () => reject(new TypeError('Failed to fetch')),
        })
      }),
  )
  const call = (index: number): FetchCall => {
    const found = calls.at(index)
    if (found === undefined) throw new Error(`no fetch call at ${index} (${calls.length} made)`)
    return found
  }
  return {
    fn,
    calls,
    call,
    last: () => call(-1),
    /** The calls of one method. */
    of: (method: 'GET' | 'POST') => calls.filter((c) => (c.init.method ?? 'GET') === method),
  }
}

export type FakeFetch = ReturnType<typeof fakeFetch>

/** Lets every settled promise chain run, inside `act`, without moving fake time. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  })
}

/** Answers a call inside `act` and lets the page react. */
export async function answer(call: FetchCall, response: Response): Promise<void> {
  call.respond(response)
  await flush()
}

/** Fails a call (network) inside `act` and lets the page react. */
export async function failCall(call: FetchCall): Promise<void> {
  call.fail()
  await flush()
}

/** Moves fake time inside `act`, then lets the page react. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flush()
}
