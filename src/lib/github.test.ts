import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveToken } from './auth'
import {
  compareBranches,
  getBranch,
  listBranches,
  mergeBranch,
  redactSecrets,
  verifyToken,
} from './github'

const TOKEN = 'github_pat_11EXAMPLE0000000000_abcdefghijklmnopqrstuvwxyz0123456789'
const REF = { owner: 'octocat', repo: 'example-repo' }

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function authHeaderOf(call: Call): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined
  return headers?.Authorization
}

const BRANCH_BODY = {
  name: 'dev',
  commit: { sha: 'abc123', commit: { message: 'x', author: { name: 'a', date: '' } } },
}

beforeEach(() => {
  calls = []
  saveToken(TOKEN)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('where the token goes', () => {
  it('sends Authorization only to https://api.github.com', async () => {
    stubFetch(BRANCH_BODY)
    await getBranch(REF, 'dev')

    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).origin).toBe('https://api.github.com')
    expect(authHeaderOf(calls[0])).toBe(`Bearer ${TOKEN}`)
  })

  it('never puts the token in the URL', async () => {
    stubFetch(BRANCH_BODY)
    await getBranch(REF, 'dev')
    await compareBranches(REF, 'main', 'dev').catch(() => undefined)
    await listBranches(REF).catch(() => undefined)

    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(call.url).not.toContain('github_pat')
      expect(new URL(call.url).search).not.toMatch(/token|auth|bearer/i)
    }
  })

  it('never puts the token in a request body', async () => {
    stubFetch({ sha: 's', html_url: 'https://github.com/a/b', commit: { message: 'm', author: null } })
    await mergeBranch(REF, 'main', 'dev', 'msg')

    const body = String(calls[0].init.body ?? '')
    expect(body).not.toContain(TOKEN)
  })

  it('omits cookies and the referrer, and never caches', async () => {
    stubFetch(BRANCH_BODY)
    await getBranch(REF, 'dev')

    expect(calls[0].init.credentials).toBe('omit')
    expect(calls[0].init.referrerPolicy).toBe('no-referrer')
    expect(calls[0].init.cache).toBe('no-store')
  })

  it('every request in a whole session stays on api.github.com', async () => {
    stubFetch(BRANCH_BODY)
    await getBranch(REF, 'dev')
    await verifyToken(TOKEN).catch(() => undefined)
    await listBranches(REF).catch(() => undefined)

    const origins = new Set(calls.map((c) => new URL(c.url).origin))
    expect([...origins]).toEqual(['https://api.github.com'])
  })

  it('refuses to read a response that was redirected off GitHub', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        // A redirect landed somewhere else; the browser stripped our header.
        url: 'https://evil.example/collected',
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      })) as unknown as typeof fetch,
    )

    await expect(getBranch(REF, 'dev')).rejects.toThrow(/unexpected host|redirected/i)
  })

  it('refuses to send anything when no token is stored', async () => {
    sessionStorage.clear()
    const fetchMock = stubFetch(BRANCH_BODY)
    await expect(getBranch(REF, 'dev')).rejects.toThrow(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('token never reaches the console', () => {
  it('logs nothing at all during a normal request', async () => {
    stubFetch(BRANCH_BODY)
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    )

    await getBranch(REF, 'dev')

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN)
      }
    }
  })
})

describe('redactSecrets', () => {
  it('strips fine-grained and classic tokens', () => {
    expect(redactSecrets(`leaked ${TOKEN} here`)).not.toContain(TOKEN)
    expect(redactSecrets('ghp_0123456789abcdefghijABCDEFGHIJ')).toContain('[redacted token]')
    expect(redactSecrets('gho_0123456789abcdefghijABCDEFGHIJ')).toContain('[redacted token]')
  })

  it('strips Authorization headers echoed back in a body', () => {
    const out = redactSecrets(`{"authorization":"Bearer ${TOKEN}"}`)
    expect(out).not.toContain(TOKEN)
  })

  it('leaves ordinary error text alone', () => {
    const msg = 'Branch "dev" was not found.'
    expect(redactSecrets(msg)).toBe(msg)
  })
})

describe('error detail is filtered before it can be displayed', () => {
  it('redacts a token that appears in a GitHub error body', async () => {
    stubFetch({ message: `Bad credentials for ${TOKEN}` }, 404)
    await getBranch(REF, 'dev').catch((err: { detail?: string; message: string }) => {
      expect(err.detail ?? '').not.toContain(TOKEN)
      expect(err.message).not.toContain(TOKEN)
    })
    expect.hasAssertions()
  })

  it('drops the stored token when GitHub answers 401', async () => {
    stubFetch({ message: 'Bad credentials' }, 401)
    await getBranch(REF, 'dev').catch(() => undefined)
    expect(sessionStorage.getItem('gitrelay.token.v1')).toBeNull()
  })
})
