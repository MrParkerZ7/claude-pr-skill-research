// The messages API as the page uses it (SPEC-001 A, B and C; contracts/messages/ is the shared truth).
import { NETWORK_ERROR, toApiError, type ApiError } from './problem'

export interface Message {
  readonly id: number
  readonly epoch: string
  readonly text: string
  readonly createdAt: string
}

export interface MessageList {
  readonly epoch: string
  readonly messages: readonly Message[]
  readonly latestId: number
}

export interface Resync {
  readonly reason: string
  readonly epoch: string
  readonly latestId: number
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

/** Every list GET asks for the most the API keeps (SPEC-001 D1). */
export const LIST_URL = '/api/messages?limit=100'
export const POST_URL = '/api/messages'

/** A stream the page builds itself resumes from the held epoch and resume point (SPEC-001 D5). */
export const streamUrl = (epoch: string, resumeId: number): string =>
  `/api/messages/stream?after=${epoch}.${resumeId}`

const EPOCH = /^[0-9a-f]{8}$/
const FRAME_ID = /^([0-9a-f]{8})\.(0|[1-9][0-9]*)$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isEpoch = (value: unknown): value is string => typeof value === 'string' && EPOCH.test(value)

const isCount = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min

export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    isCount(value.id, 1) &&
    isEpoch(value.epoch) &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string' &&
    !Number.isNaN(Date.parse(value.createdAt))
  )
}

export function isMessageList(value: unknown): value is MessageList {
  if (!isRecord(value) || !isEpoch(value.epoch) || !isCount(value.latestId, 0)) return false
  const { epoch, messages } = value
  return Array.isArray(messages) && messages.every((m) => isMessage(m) && m.epoch === epoch)
}

export function isResync(value: unknown): value is Resync {
  return (
    isRecord(value) &&
    typeof value.reason === 'string' &&
    isEpoch(value.epoch) &&
    isCount(value.latestId, 0)
  )
}

/** A frame id, `<epoch>.<seq>`, or null when it is not one. */
export function parseFrameId(id: string): { epoch: string; seq: number } | null {
  const match = FRAME_ID.exec(id)
  if (match === null) return null
  const [, epoch = '', digits = ''] = match
  const seq = Number(digits)
  return Number.isSafeInteger(seq) ? { epoch, seq } : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** A `message` frame's message, or null when its data is not a message or its id is not `<epoch>.<id>`. */
export function parseMessageFrame(data: string, lastEventId: string): Message | null {
  const message = parseJson(data)
  if (!isMessage(message)) return null
  const id = parseFrameId(lastEventId)
  return id !== null && id.epoch === message.epoch && id.seq === message.id ? message : null
}

/** A `resync` frame's data, or null when it is not valid (the page still reloads). */
export function parseResync(data: string): Resync | null {
  const resync = parseJson(data)
  return isResync(resync) ? resync : null
}

async function request<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  guard: (value: unknown) => value is T,
): Promise<Result<T>> {
  let response: Response
  let body: unknown
  try {
    response = await fetchFn(url, init)
    if (!response.ok) return { ok: false, error: await toApiError(response) }
    body = await response.json()
  } catch {
    // A rejection, an abort (the timeout included) or a body that cannot be read.
    return { ok: false, error: NETWORK_ERROR }
  }
  return guard(body)
    ? { ok: true, value: body }
    : { ok: false, error: { kind: 'http', status: response.status } }
}

export function fetchMessages(fetchFn: FetchFn, signal: AbortSignal): Promise<Result<MessageList>> {
  return request(fetchFn, LIST_URL, { signal }, isMessageList)
}

export function postMessage(
  fetchFn: FetchFn,
  text: string,
  signal: AbortSignal,
): Promise<Result<Message>> {
  return request(
    fetchFn,
    POST_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    },
    isMessage,
  )
}
