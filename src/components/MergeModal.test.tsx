/**
 * A release must move production to exactly the commit on dev, never write a
 * merge commit, and never touch production when the two branches have both
 * moved on. These tests drive the real dialog against a stubbed GitHub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MergeModal } from './MergeModal'
import { saveToken } from '../lib/auth'

const REF = { owner: 'octocat', repo: 'example-repo' }
const DEV_SHA = 'd'.repeat(40)
const MAIN_SHA = 'e'.repeat(40)

interface Call {
  method: string
  path: string
  body: unknown
}

let calls: Call[] = []

function branchBody(name: string, sha: string) {
  return { name, commit: { sha, commit: { message: `tip of ${name}`, author: { name: 'a', date: '' } } } }
}

/** Serves the handful of endpoints the dialog uses; everything else is a 404. */
function stubGitHub(opts: { status: 'ahead' | 'diverged'; patch?: { status: number; body: unknown } }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })

      let status = 200
      let body: unknown = { message: 'Not Found' }
      if (url.pathname.endsWith('/branches/dev')) body = branchBody('dev', DEV_SHA)
      else if (url.pathname.endsWith('/branches/main')) body = branchBody('main', MAIN_SHA)
      else if (url.pathname.includes('/compare/')) {
        body = {
          status: opts.status,
          ahead_by: 2,
          behind_by: opts.status === 'diverged' ? 3 : 0,
          total_commits: 2,
          commits: [],
          files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
          base_commit: { sha: MAIN_SHA },
        }
      } else if (method === 'PATCH' && url.pathname.endsWith('/git/refs/heads/main')) {
        status = opts.patch?.status ?? 200
        body = opts.patch?.body ?? { ref: 'refs/heads/main', object: { sha: DEV_SHA } }
      } else status = 404

      return {
        ok: status >= 200 && status < 300,
        status,
        url: url.toString(),
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    }),
  )
}

function renderRelease(onMerged = vi.fn()) {
  render(
    <MergeModal
      repo={REF}
      repoUrl="https://github.com/octocat/example-repo"
      source="dev"
      target="main"
      isRelease
      strategy="fast-forward"
      onClose={() => undefined}
      onMerged={onMerged}
    />,
  )
  return onMerged
}

beforeEach(() => {
  calls = []
  saveToken('github_pat_11EXAMPLE0000000000_abcdefghijklmnopqrstuvwxyz0123456789')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('release dev → main', () => {
  it('fast-forwards main to the reviewed dev commit without a merge commit', async () => {
    stubGitHub({ status: 'ahead' })
    const onMerged = renderRelease()

    fireEvent.click(await screen.findByRole('button', { name: 'Fast-forward main to dev' }))
    await waitFor(() => expect(onMerged).toHaveBeenCalled())

    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/repos/octocat/example-repo/git/refs/heads/main',
        body: { sha: DEV_SHA, force: false },
      },
    ])
    expect(calls.some((c) => c.path.endsWith('/merges'))).toBe(false)
    expect(onMerged.mock.calls[0][0]).toMatchObject({ kind: 'fast-forward', sha: DEV_SHA })
  })

  it('refuses a diverged pair and writes nothing', async () => {
    stubGitHub({ status: 'diverged' })
    const onMerged = renderRelease()

    expect(await screen.findByText('Branches have diverged')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Fast-forward main to dev' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(onMerged).not.toHaveBeenCalled()
  })

  it('reports main moving underneath the release as divergence, not success', async () => {
    stubGitHub({
      status: 'ahead',
      patch: { status: 422, body: { message: 'Update is not a fast forward' } },
    })
    const onMerged = renderRelease()

    fireEvent.click(await screen.findByRole('button', { name: 'Fast-forward main to dev' }))

    expect(await screen.findByText('Branches have diverged')).toBeTruthy()
    expect(onMerged).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    expect(calls.some((c) => c.path.endsWith('/merges'))).toBe(false)
  })
})
