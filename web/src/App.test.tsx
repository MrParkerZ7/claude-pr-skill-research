import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('T002-S1 renders a level-1 heading "Live messages", a banner and one main', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: 'Live messages' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })
})
