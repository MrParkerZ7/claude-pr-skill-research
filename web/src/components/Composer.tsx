import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import { sendErrorCopy, type ApiError } from '../api/problem'
import { MAX_LENGTH, canSend, codePoints } from '../feed/feedReducer'

interface Props {
  readonly draft: string
  readonly sending: boolean
  readonly error: ApiError | null
  readonly inputRef: RefObject<HTMLTextAreaElement | null>
  readonly onEdit: (draft: string) => void
  readonly onSend: () => void
}

/** SPEC-001 D3 and D4. Enter does exactly what Send does; the hook decides whether a send may start. */
export function Composer({ draft, sending, error, inputRef, onEdit, onSend }: Props) {
  const length = codePoints(draft)
  const over = length > MAX_LENGTH
  const describedBy = error === null ? 'message-counter' : 'message-counter send-error'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // While sending the textarea is read-only and keeps focus, so nothing typed is lost when the draft clears.
    inputRef.current?.focus()
    onSend()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari reports isComposing false on the Enter that confirms an IME candidate; keyCode 229 marks it.
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    if (event.key !== 'Enter' || event.shiftKey || composing) return
    event.preventDefault()
    onSend()
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label className="composer__label" htmlFor="message">
        Message
      </label>
      <textarea
        id="message"
        className="composer__input"
        rows={3}
        ref={inputRef}
        value={draft}
        readOnly={sending}
        aria-describedby={describedBy}
        onChange={(event) => onEdit(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="composer__footer">
        <p
          id="message-counter"
          className={over ? 'composer__counter composer__counter--over' : 'composer__counter'}
        >
          {`${length} / ${MAX_LENGTH}`}
        </p>
        <button type="submit" className="button" disabled={sending || !canSend(draft)}>
          Send
        </button>
      </div>
      {error !== null && (
        <p className="composer__error" role="alert" id="send-error">
          {sendErrorCopy(error)}
        </p>
      )}
    </form>
  )
}
