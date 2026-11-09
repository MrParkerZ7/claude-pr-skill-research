// The page's effects: the list loads, the stream and its retries, and the post (SPEC-001 D1, D2, D5).
import { useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import {
  fetchMessages,
  parseMessageFrame,
  parseResync,
  postMessage,
  streamUrl,
  type FetchFn,
} from '../api/messages'
import {
  canSend,
  feedReducer,
  initialFeedState,
  type FeedAction,
  type FeedState,
} from './feedReducer'

/** What the hook needs of an `EventSource`; the browser's satisfies it. */
export interface StreamSource {
  readonly readyState: number
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

export type StreamSourceCtor = new (url: string) => StreamSource

export interface FeedDeps {
  readonly fetch?: FetchFn
  readonly EventSource?: StreamSourceCtor
}

export interface Feed {
  readonly state: FeedState
  edit(draft: string): void
  send(): void
  retry(): void
  retryReload(): void
  reconnect(): void
}

/** Every list GET and the POST give up after this long (SPEC-001 D1, D4). */
export const REQUEST_TIMEOUT_MS = 10_000
/** The page's own retries after a closed stream wait 1, 2, 4, 8 and 16 s (SPEC-001 D2). */
export const MAX_ATTEMPTS = 5
export const backoffDelay = (attempt: number): number => 1000 * 2 ** (attempt - 1)

const CLOSED = 2

interface Pending {
  readonly controller: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  cancelled: boolean
}

type Controller = Omit<Feed, 'state'> & { start(): void; dispose(): void }

function createController(
  fetchFn: FetchFn,
  Source: StreamSourceCtor,
  dispatch: Dispatch<FeedAction>,
): Controller {
  // The controller's own copy of the state, kept by the same pure reducer, so a decision never reads a stale render.
  let state = initialFeedState()
  let source: StreamSource | null = null
  let backoff: ReturnType<typeof setTimeout> | null = null
  let load: Pending | null = null
  let reload: Pending | null = null
  let post: Pending | null = null

  const apply = (action: FeedAction) => {
    state = feedReducer(state, action)
    dispatch(action)
  }

  const begin = (): Pending => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    return { controller, timer, cancelled: false }
  }

  /** A superseded or unmounted request: aborted, and its result ignored. */
  const cancel = (pending: Pending | null) => {
    if (pending === null) return
    pending.cancelled = true
    clearTimeout(pending.timer)
    pending.controller.abort()
  }

  const clearBackoff = () => {
    if (backoff === null) return
    clearTimeout(backoff)
    backoff = null
  }

  const closeSource = () => {
    source?.close()
    source = null
  }

  /** SPEC-001 D2: a closed stream is retried after 1, 2, 4, 8 and 16 s, then the page is Offline. */
  const onClosed = () => {
    closeSource()
    const attempt = state.attempt + 1
    if (attempt > MAX_ATTEMPTS) {
      apply({ type: 'connection', state: 'offline' })
      return
    }
    apply({ type: 'connection', state: 'reconnecting', attempt })
    backoff = setTimeout(() => {
      backoff = null
      openStream()
    }, backoffDelay(attempt))
  }

  /** At most one stream: any open one is closed first. It resumes from the held epoch and resume point. */
  const openStream = () => {
    closeSource()
    clearBackoff()
    // A stream opens only after the first successful list load, so an epoch is held.
    const es = new Source(streamUrl(state.epoch!, state.resumeId))
    source = es
    es.addEventListener('open', () => {
      if (source === es) apply({ type: 'connection', state: 'live', attempt: 0 })
    })
    es.addEventListener('message', (event) => {
      if (source !== es) return
      const message = parseMessageFrame(event.data, event.lastEventId)
      if (message !== null) apply({ type: 'received', message })
    })
    es.addEventListener('resync', (event) => {
      if (source !== es) return
      apply({ type: 'resync', resync: parseResync(event.data) })
      void reloadList()
    })
    es.addEventListener('error', () => {
      if (source !== es) return
      if (es.readyState === CLOSED) onClosed()
      // CONNECTING: the browser retries on its own; the attempt being waited on, if any, stays.
      else apply({ type: 'connection', state: 'reconnecting' })
    })
  }

  /** Leaving Offline: a stream at once, as attempt 1 (SPEC-001 D2). */
  const reopen = () => {
    apply({ type: 'connection', state: 'reconnecting', attempt: 1 })
    openStream()
  }

  /** Any 2xx while Offline means the API just answered. */
  const answered = (wasOffline: boolean) => {
    if (wasOffline) reopen()
  }

  const loadList = async () => {
    const pending = begin()
    load = pending
    const result = await fetchMessages(fetchFn, pending.controller.signal)
    clearTimeout(pending.timer)
    if (pending.cancelled) return
    load = null
    if (!result.ok) {
      apply({ type: 'loadFailed' })
      return
    }
    apply({ type: 'loaded', list: result.value })
    // The first successful load opens the one stream (SPEC-001 D5).
    apply({ type: 'connection', state: 'connecting', attempt: 0 })
    openStream()
  }

  /** A newer reload aborts a pending one; only the newest result applies (SPEC-001 D5). */
  const reloadList = async () => {
    cancel(reload)
    const pending = begin()
    reload = pending
    const result = await fetchMessages(fetchFn, pending.controller.signal)
    clearTimeout(pending.timer)
    if (pending.cancelled) return
    reload = null
    if (!result.ok) {
      apply({ type: 'reloadFailed' })
      return
    }
    const wasOffline = state.connection === 'offline'
    apply({ type: 'resynced', list: result.value })
    answered(wasOffline)
  }

  const send = async () => {
    const { draft, sending } = state.composer
    if (sending || !canSend(draft)) return
    apply({ type: 'sendStarted' })
    const pending = begin()
    post = pending
    const result = await postMessage(fetchFn, draft, pending.controller.signal)
    clearTimeout(pending.timer)
    if (pending.cancelled) return
    post = null
    if (!result.ok) {
      apply({ type: 'sendFailed', error: result.error })
      return
    }
    const message = result.value
    // A 201 of another epoch reloads the list if one had been loaded (SPEC-001 D5).
    const reloadNeeded = message.epoch !== state.epoch && state.list === 'ready'
    const wasOffline = state.connection === 'offline'
    apply({ type: 'sent', message })
    if (reloadNeeded) void reloadList()
    answered(wasOffline)
  }

  return {
    start: () => void loadList(),
    dispose: () => {
      cancel(load)
      cancel(reload)
      cancel(post)
      clearBackoff()
      closeSource()
    },
    edit: (draft) => apply({ type: 'edited', draft }),
    send: () => void send(),
    retry: () => {
      if (state.list !== 'error') return
      apply({ type: 'retry' })
      void loadList()
    },
    retryReload: () => {
      if (state.reload !== 'error') return
      apply({ type: 'reloadRetry' })
      void reloadList()
    },
    reconnect: () => {
      if (state.connection === 'offline') reopen()
    },
  }
}

const globalFetch: FetchFn = (input, init) => globalThis.fetch(input, init)

/** The live feed. `fetch` and `EventSource` default to the browser's, read when the page mounts. */
export function useMessageFeed(deps: FeedDeps = {}): Feed {
  const [state, dispatch] = useReducer(feedReducer, undefined, initialFeedState)
  const [initialDeps] = useState(deps)
  const controller = useRef<Controller | null>(null)

  useEffect(() => {
    const created = createController(
      initialDeps.fetch ?? globalFetch,
      initialDeps.EventSource ?? globalThis.EventSource,
      dispatch,
    )
    controller.current = created
    created.start()
    return () => {
      created.dispose()
      controller.current = null
    }
  }, [initialDeps])

  const [actions] = useState(() => ({
    edit: (draft: string) => controller.current?.edit(draft),
    send: () => controller.current?.send(),
    retry: () => controller.current?.retry(),
    retryReload: () => controller.current?.retryReload(),
    reconnect: () => controller.current?.reconnect(),
  }))

  return { state, ...actions }
}
