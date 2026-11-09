// The page's state and its pure reducer (SPEC-001 D1 to D5). The hook in useMessageFeed.ts owns the effects.
import type { Message, MessageList, Resync } from '../api/messages'
import type { ApiError } from '../api/problem'

export type ListStatus = 'loading' | 'ready' | 'error'
export type ReloadStatus = 'idle' | 'pending' | 'error'
export type Connection = 'none' | 'connecting' | 'live' | 'reconnecting' | 'offline'

export interface Composer {
  readonly draft: string
  readonly sending: boolean
  readonly error: ApiError | null
}

export interface FeedState {
  readonly list: ListStatus
  readonly reload: ReloadStatus
  readonly connection: Connection
  /** The page's own retry being waited on or tried, 1 to 5; 0 while none is. */
  readonly attempt: number
  /** The held epoch; null until a list load, a resync or a `201` names one. */
  readonly epoch: string | null
  /** The resume point; it belongs to `epoch`. */
  readonly resumeId: number
  /** Newest first, all of `epoch`, at most `MAX_MESSAGES`. */
  readonly messages: readonly Message[]
  readonly composer: Composer
}

export type FeedAction =
  | { readonly type: 'loaded'; readonly list: MessageList }
  | { readonly type: 'loadFailed' }
  | { readonly type: 'retry' }
  | { readonly type: 'received'; readonly message: Message }
  | { readonly type: 'resync'; readonly resync: Resync | null }
  | { readonly type: 'resynced'; readonly list: MessageList }
  | { readonly type: 'reloadFailed' }
  | { readonly type: 'reloadRetry' }
  | { readonly type: 'connection'; readonly state: Connection; readonly attempt?: number }
  | { readonly type: 'edited'; readonly draft: string }
  | { readonly type: 'sendStarted' }
  | { readonly type: 'sent'; readonly message: Message }
  | { readonly type: 'sendFailed'; readonly error: ApiError }

export const MAX_MESSAGES = 100
export const MAX_LENGTH = 280

export const initialFeedState = (): FeedState => ({
  list: 'loading',
  reload: 'idle',
  connection: 'none',
  attempt: 0,
  epoch: null,
  resumeId: 0,
  messages: [],
  composer: { draft: '', sending: false, error: null },
})

/** The length the counter shows: code points of the trimmed text (SPEC-001 D3). */
export const codePoints = (draft: string): number => [...draft.trim()].length

export function canSend(draft: string): boolean {
  const length = codePoints(draft)
  return length >= 1 && length <= MAX_LENGTH
}

/** By id, de-duplicated, newest first, at most 100 (SPEC-001 D5). */
export function mergeMessages(
  held: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  const byId = new Map<number, Message>()
  for (const message of held) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, MAX_MESSAGES)
}

/**
 * SPEC-001 D5, adopting an epoch: every list load, resync and `201` that names another epoch than the held one (or
 * arrives while none is held) goes through here. It drops the other epoch's messages and moves the resume point.
 */
export function adoptEpoch(state: FeedState, epoch: string, resumeId: number): FeedState {
  return {
    ...state,
    epoch,
    resumeId,
    messages: state.messages.filter((message) => message.epoch === epoch),
  }
}

/** A list load or a reload: a foreign epoch is adopted; within the held one the resume point only rises. */
function takeList(state: FeedState, list: MessageList): FeedState {
  return state.epoch === list.epoch
    ? { ...state, resumeId: Math.max(state.resumeId, list.latestId) }
    : adoptEpoch(state, list.epoch, list.latestId)
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'loaded': {
      const next = takeList(state, action.list)
      return {
        ...next,
        list: 'ready',
        messages: mergeMessages(next.messages, action.list.messages),
      }
    }
    case 'loadFailed':
      return { ...state, list: 'error' }
    case 'retry':
      return { ...state, list: 'loading' }
    case 'received': {
      const { message } = action
      if (message.epoch !== state.epoch) return state
      return {
        ...state,
        resumeId: Math.max(state.resumeId, message.id),
        messages: mergeMessages(state.messages, [message]),
      }
    }
    case 'resync': {
      const { resync } = action
      const next =
        resync === null
          ? state
          : resync.epoch === state.epoch
            ? { ...state, resumeId: resync.latestId }
            : adoptEpoch(state, resync.epoch, resync.latestId)
      return { ...next, reload: 'pending' }
    }
    case 'resynced': {
      const { list } = action
      const next = takeList(state, list)
      // The reload replaces the held messages; the held ones above its latestId streamed in meanwhile and stay.
      const newer = next.messages.filter((message) => message.id > list.latestId)
      return { ...next, reload: 'idle', messages: mergeMessages(newer, list.messages) }
    }
    case 'reloadFailed':
      return { ...state, reload: 'error' }
    case 'reloadRetry':
      return { ...state, reload: 'pending' }
    case 'connection':
      return { ...state, connection: action.state, attempt: action.attempt ?? state.attempt }
    case 'edited':
      return { ...state, composer: { ...state.composer, draft: action.draft, error: null } }
    case 'sendStarted':
      return { ...state, composer: { ...state.composer, sending: true, error: null } }
    case 'sendFailed':
      return { ...state, composer: { ...state.composer, sending: false, error: action.error } }
    case 'sent': {
      const { message } = action
      const composer: Composer = { draft: '', sending: false, error: null }
      if (message.epoch === state.epoch) {
        // Within the held epoch a 201 never moves the resume point.
        return { ...state, composer, messages: mergeMessages(state.messages, [message]) }
      }
      const next = adoptEpoch(state, message.epoch, 0)
      return {
        ...next,
        composer,
        reload: state.list === 'ready' ? 'pending' : state.reload,
        messages: mergeMessages(next.messages, [message]),
      }
    }
  }
}
