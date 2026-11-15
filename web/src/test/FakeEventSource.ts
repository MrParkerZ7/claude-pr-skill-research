// A scripted EventSource: tests open it, feed it frames and fail it, in either of the browser's two error states.
import type { StreamSource } from '../feed/useMessageFeed'

type Listener = (event: MessageEvent<string>) => void

export class FakeEventSource implements StreamSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  /** Every source constructed since the last `reset()`, oldest first. */
  static instances: FakeEventSource[] = []

  static reset(): void {
    FakeEventSource.instances = []
  }

  /** The newest source; the test fails if none was constructed. */
  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1)
    if (source === undefined) throw new Error('no EventSource was constructed')
    return source
  }

  /** The sources not closed by the page. */
  static openOnes(): FakeEventSource[] {
    return FakeEventSource.instances.filter((source) => source.closeCalls === 0)
  }

  readonly url: string
  readyState: number = FakeEventSource.CONNECTING
  closeCalls = 0
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  /** The `after` query parameter of the URL the page built. */
  get after(): string | null {
    return new URL(this.url, 'http://localhost').searchParams.get('after')
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = FakeEventSource.CLOSED
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.dispatch('open', new MessageEvent('open'))
  }

  /** A `message` frame. `data` is sent as given when it is a string, else as JSON; `id` defaults to `<epoch>.<id>`. */
  message(data: unknown, id?: string): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    const frameId = id ?? FakeEventSource.idOf(data)
    this.dispatch('message', new MessageEvent('message', { data: text, lastEventId: frameId }))
  }

  resync(data: unknown, id = ''): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    this.dispatch('resync', new MessageEvent('resync', { data: text, lastEventId: id }))
  }

  /** The browser's `error`: CONNECTING when it retries by itself, CLOSED when it gave up. */
  fail(state: 'connecting' | 'closed'): void {
    this.readyState = state === 'closed' ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING
    this.dispatch('error', new MessageEvent('error'))
  }

  private dispatch(type: string, event: MessageEvent<string>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  private static idOf(data: unknown): string {
    if (typeof data === 'object' && data !== null && 'epoch' in data && 'id' in data) {
      return `${String(data.epoch)}.${String(data.id)}`
    }
    return ''
  }
}
