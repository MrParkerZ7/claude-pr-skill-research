import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '../feed/feedReducer'
import { ConnectionStatus } from './ConnectionStatus'

const pill = (connection: Connection, attempt = 0) => {
  const onReconnect = vi.fn()
  const view = render(
    <ConnectionStatus connection={connection} attempt={attempt} onReconnect={onReconnect} />,
  )
  return { ...view, onReconnect, status: screen.getByRole('status') }
}

describe('ConnectionStatus (SPEC-001 D2)', () => {
  it('T006-S1 says "Not connected" while no stream exists', () => {
    expect(pill('none').status).toHaveTextContent(/^Not connected$/)
  })

  it('T006-S1 says "Connecting…" until the stream opens, then "Live"', () => {
    const { rerender, onReconnect } = pill('connecting')
    expect(screen.getByRole('status')).toHaveTextContent(/^Connecting…$/)
    rerender(<ConnectionStatus connection="live" attempt={0} onReconnect={onReconnect} />)
    expect(screen.getByRole('status')).toHaveTextContent(/^Live$/)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('T006-S9 says "Reconnecting…" while the browser retries', () => {
    expect(pill('reconnecting').status).toHaveTextContent(/^Reconnecting…$/)
  })

  it('T006-S10 names the attempt being waited on', () => {
    expect(pill('reconnecting', 1).status).toHaveTextContent(/^Reconnecting… \(attempt 1 of 5\)$/)
  })

  it('T006-S10 names the 5th attempt too', () => {
    expect(pill('reconnecting', 5).status).toHaveTextContent(/^Reconnecting… \(attempt 5 of 5\)$/)
  })

  it('T006-F11 says "Offline" with a Reconnect button, which only then exists', () => {
    const { onReconnect, status } = pill('offline', 5)
    expect(status).toHaveTextContent(/^Offline$/)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})
