import { describe, expect, it } from 'vitest'
import { reply } from '../test/fixtures'
import { sendErrorCopy, toApiError, type ApiError } from './problem'

const problem = (status: number, body: object): ApiError => ({
  kind: 'problem',
  status,
  problem: body,
})

describe('toApiError', () => {
  it('T006-F7 reads a problem body only from a JSON problem type, else keeps the status alone', async () => {
    const body = { title: 'Invalid request', reason: 'blank' }
    for (const type of [
      'application/problem+json',
      'application/problem+json;charset=UTF-8',
      'application/json',
      'Application/Problem+JSON',
    ]) {
      expect(await toApiError(reply(400, body, type)), type).toEqual(problem(400, body))
    }
    for (const [response, label] of [
      [reply(503, 'Service Unavailable', 'text/plain'), 'text/plain'],
      [reply(400, body, 'application/problem+jsonx'), 'a longer subtype'],
      [reply(418), 'no body, no type'],
      [reply(400, undefined, 'application/problem+json'), 'an empty problem body'],
      [reply(400, '{"oops', 'application/problem+json'), 'a broken problem body'],
      [reply(400, [1], 'application/problem+json'), 'an array'],
      [reply(400, 'null', 'application/problem+json'), 'null'],
    ] as const) {
      const status = response.status
      expect(await toApiError(response), label).toEqual({ kind: 'http', status })
    }
  })
})

describe('sendErrorCopy (SPEC-001 D4)', () => {
  it('T006-F7 gives the D4 copy for each reason, 413, a problem with or without detail, and a 4xx with no body', () => {
    const cases: [ApiError, string][] = [
      [problem(400, { reason: 'blank' }), 'Write something first.'],
      [problem(400, { reason: 'too_long' }), 'Message is longer than 280 characters.'],
      [
        problem(400, { reason: 'control_character' }),
        "Message contains characters that aren't allowed.",
      ],
      [
        problem(400, { reason: 'bidi_control' }),
        "Message contains characters that aren't allowed.",
      ],
      [problem(413, { title: 'Payload Too Large' }), 'Message is too large.'],
      [{ kind: 'http', status: 413 }, 'Message is too large.'],
      [problem(422, { detail: 'Not today.' }), 'Not today.'],
      [problem(422, {}), "Couldn't send (error 422)."],
      [problem(422, { detail: '  ' }), "Couldn't send (error 422)."],
      [problem(422, { detail: 5 }), "Couldn't send (error 422)."],
      [problem(400, { reason: 'missing', detail: 'Text is required.' }), 'Text is required.'],
      [problem(400, { reason: 'toString' }), "Couldn't send (error 400)."],
      [problem(500, { detail: 'Boom.' }), 'Boom.'],
      [{ kind: 'http', status: 418 }, "Couldn't send (error 418)."],
      [{ kind: 'http', status: 499 }, "Couldn't send (error 499)."],
    ]
    for (const [error, copy] of cases) {
      expect(sendErrorCopy(error), JSON.stringify(error)).toBe(copy)
    }
  })

  it('T006-F3 gives the network copy for a network failure and for a 5xx without a problem body', () => {
    const copy = "Couldn't send. Check your connection and try again."
    expect(sendErrorCopy({ kind: 'network' })).toBe(copy)
    expect(sendErrorCopy({ kind: 'http', status: 500 })).toBe(copy)
    expect(sendErrorCopy({ kind: 'http', status: 503 })).toBe(copy)
  })
})
