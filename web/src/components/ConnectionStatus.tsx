import { MAX_ATTEMPTS } from '../feed/useMessageFeed'
import type { Connection } from '../feed/feedReducer'

interface Props {
  readonly connection: Connection
  readonly attempt: number
  readonly onReconnect: () => void
}

/** SPEC-001 D2: the pill always says the state in words, never colour alone. */
function pillText(connection: Connection, attempt: number): string {
  switch (connection) {
    case 'none':
      return 'Not connected'
    case 'connecting':
      return 'Connecting…'
    case 'live':
      return 'Live'
    case 'reconnecting':
      return attempt > 0 ? `Reconnecting… (attempt ${attempt} of ${MAX_ATTEMPTS})` : 'Reconnecting…'
    case 'offline':
      return 'Offline'
  }
}

export function ConnectionStatus({ connection, attempt, onReconnect }: Props) {
  return (
    <div className="connection">
      <p className={`pill pill--${connection}`} role="status">
        {pillText(connection, attempt)}
      </p>
      {connection === 'offline' && (
        <button type="button" className="button button--quiet" onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </div>
  )
}
