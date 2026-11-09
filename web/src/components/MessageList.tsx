import type { Message } from '../api/messages'
import type { ListStatus, ReloadStatus } from '../feed/feedReducer'

// The browser's locale, medium date and short time (SPEC-001 D6).
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

interface Props {
  readonly list: ListStatus
  readonly reload: ReloadStatus
  readonly messages: readonly Message[]
}

/** The list, newest first. It is not a live region: the pill is the announced status (SPEC-001 D6). */
export function MessageList({ list, reload, messages }: Props) {
  const empty = list === 'ready' && reload === 'idle' && messages.length === 0
  return (
    <div className="feed">
      {list === 'loading' && <p className="feed__note">Loading messages…</p>}
      {empty && <p className="feed__note">No messages yet. Send the first one.</p>}
      {messages.length > 0 && (
        // role="list" keeps the list semantics in Safari, which drops them from a list with list-style: none.
        <ul className="feed__list" role="list" aria-label="Messages">
          {messages.map((message) => (
            <li className="message" key={message.id}>
              <p className="message__text">{message.text}</p>
              <time className="message__time" dateTime={message.createdAt}>
                {timeFormat.format(new Date(message.createdAt))}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
