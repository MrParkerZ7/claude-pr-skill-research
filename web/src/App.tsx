import { useRef } from 'react'
import './App.css'
import { Composer } from './components/Composer'
import { ConnectionStatus } from './components/ConnectionStatus'
import { MessageList } from './components/MessageList'
import { useMessageFeed } from './feed/useMessageFeed'

/** The live feed page (SPEC-001 D1): the header and its pill, the composer, the list alert, the list. */
export default function App() {
  const feed = useMessageFeed()
  const { list, reload, connection, attempt, messages, composer } = feed.state
  const input = useRef<HTMLTextAreaElement>(null)

  // Retry and Reconnect move focus to the textarea (SPEC-001 D1), since their button goes away.
  const thenFocus = (action: () => void) => () => {
    action()
    input.current?.focus()
  }

  const alert =
    list === 'error'
      ? { copy: "Couldn't load messages.", retry: feed.retry }
      : reload === 'error'
        ? { copy: "Couldn't reload messages.", retry: feed.retryReload }
        : null

  return (
    <>
      <header className="app-header">
        <h1 className="app-header__title">Live messages</h1>
        <ConnectionStatus
          connection={connection}
          attempt={attempt}
          onReconnect={thenFocus(feed.reconnect)}
        />
      </header>
      <main className="app-main">
        <Composer
          draft={composer.draft}
          sending={composer.sending}
          error={composer.error}
          inputRef={input}
          onEdit={feed.edit}
          onSend={feed.send}
        />
        {alert !== null && (
          <div className="feed-alert">
            <p className="feed-alert__text" role="alert">
              {alert.copy}
            </p>
            <button type="button" className="button button--quiet" onClick={thenFocus(alert.retry)}>
              Retry
            </button>
          </div>
        )}
        <MessageList list={list} reload={reload} messages={messages} />
      </main>
    </>
  )
}
