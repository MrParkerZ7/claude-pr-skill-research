// A failed API call, and the send-error copy of SPEC-001 D4.

/** An RFC 9457 problem body, as far as the page reads it. */
export interface Problem {
  readonly detail?: unknown
  readonly reason?: unknown
}

export type ApiError =
  | { readonly kind: 'problem'; readonly status: number; readonly problem: Problem }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'network' }

export const NETWORK_ERROR: ApiError = { kind: 'network' }

const PROBLEM_TYPE = /^application\/(?:problem\+)?json\s*(?:;|$)/i

const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The error for a response that is not 2xx: its problem body when it has one, else its status. */
export async function toApiError(response: Response): Promise<ApiError> {
  const status = response.status
  if (PROBLEM_TYPE.test(response.headers.get('content-type') ?? '')) {
    try {
      const body: unknown = await response.json()
      if (isProblem(body)) return { kind: 'problem', status, problem: body }
    } catch {
      // An unreadable body is the same as none.
    }
  }
  return { kind: 'http', status }
}

const NETWORK_COPY = "Couldn't send. Check your connection and try again."

function reasonCopy(reason: unknown): string | null {
  switch (reason) {
    case 'blank':
      return 'Write something first.'
    case 'too_long':
      return 'Message is longer than 280 characters.'
    case 'control_character':
    case 'bidi_control':
      return "Message contains characters that aren't allowed."
    default:
      return null
  }
}

/** SPEC-001 D4: what the composer says when a send fails. */
export function sendErrorCopy(error: ApiError): string {
  if (error.kind === 'network') return NETWORK_COPY
  if (error.kind === 'problem') {
    const known = reasonCopy(error.problem.reason)
    if (known !== null) return known
  }
  if (error.status === 413) return 'Message is too large.'
  if (error.kind === 'problem') {
    const detail = error.problem.detail
    if (typeof detail === 'string' && detail.trim() !== '') return detail
  } else if (error.status >= 500) {
    return NETWORK_COPY
  }
  return `Couldn't send (error ${error.status}).`
}
