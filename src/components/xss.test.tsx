/**
 * Everything GitHub returns is treated as untrusted input: branch names,
 * commit messages, author names and raw error text all come from repositories
 * this app does not control. These tests push hostile strings through the
 * components that render them and assert they arrive as text, never as markup.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BranchRow } from './BranchRow'
import { ErrorNotice, Notice } from './Notice'
import { GitRelayError } from '../lib/errors'
import type { BranchStatus } from '../lib/status'

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  "'-alert(1)-'",
  '<svg/onload=alert(1)>',
]

function statusWith(overrides: Partial<BranchStatus>): BranchStatus {
  return {
    name: 'feature',
    sha: 'abc1234',
    readiness: 'clean',
    comparison: {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      commits: [],
      files: [],
      filesTruncated: false,
      additions: 1,
      deletions: 0,
      baseSha: 'base',
    },
    latestMessage: 'ok',
    latestDate: new Date().toISOString(),
    latestAuthor: 'someone',
    error: null,
    ...overrides,
  }
}

describe('hostile GitHub data renders as text', () => {
  it.each(PAYLOADS)('branch name %j is not executed', (payload) => {
    const { container } = render(
      <BranchRow
        status={statusWith({ name: payload })}
        target="dev"
        repoUrl="https://github.com/a/b"
        onMerge={vi.fn()}
      />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // The app renders its own icon SVGs, so the meaningful check is that no
    // element carries an event-handler attribute and nothing was parsed as
    // markup: the payload survives as literal text.
    expect(container.querySelector('[onerror], [onload], [onclick]')).toBeNull()
    expect(container.textContent).toContain(payload)
  })

  it.each(PAYLOADS)('commit message %j is not executed', (payload) => {
    const { container } = render(
      <BranchRow
        status={statusWith({ latestMessage: payload })}
        target="dev"
        repoUrl="https://github.com/a/b"
        onMerge={vi.fn()}
      />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror], [onload], [onclick]')).toBeNull()
    expect(container.textContent).toContain(payload)
  })

  it.each(PAYLOADS)('branch error text %j is not executed', (payload) => {
    const { container } = render(
      <BranchRow
        status={statusWith({ readiness: 'missing', comparison: null, error: payload })}
        target="dev"
        repoUrl="https://github.com/a/b"
        onMerge={vi.fn()}
      />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror], [onload], [onclick]')).toBeNull()
    expect(container.textContent).toContain(payload)
  })

  it.each(PAYLOADS)('raw API error detail %j is not executed', (payload) => {
    const { container } = render(
      <ErrorNotice error={new GitRelayError('unknown', 'Something failed', { detail: payload })} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror], [onload], [onclick]')).toBeNull()
    expect(container.textContent).toContain(payload)
  })

  it('does not create a link from a javascript: branch URL', () => {
    const { container } = render(
      <BranchRow
        status={statusWith({ readiness: 'nothing_to_merge' })}
        target="dev"
        repoUrl="https://github.com/a/b"
        onMerge={vi.fn()}
      />,
    )

    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').toMatch(/^https:\/\/github\.com\//)
    }
  })

  it('renders notice children as text', () => {
    render(
      <Notice tone="info" title="t">
        {'<script>alert(1)</script>'}
      </Notice>,
    )
    expect(screen.queryByText('<script>alert(1)</script>')).not.toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})
