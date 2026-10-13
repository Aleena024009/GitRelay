import type { ReactNode } from 'react'
import type { GitRelayError } from '../lib/errors'

interface NoticeProps {
  tone: 'error' | 'warn' | 'success' | 'info'
  title: string
  children?: ReactNode
  /** Raw API text, tucked behind a disclosure so it never leads the UI. */
  detail?: string
}

const GLYPH = { error: '⚠', warn: '⚠', success: '✓', info: 'ℹ' } as const

export function Notice({ tone, title, children, detail }: NoticeProps) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="notice-title">
        <span className="glyph" aria-hidden="true">{GLYPH[tone]}</span>
        <span>{title}</span>
      </div>
      {children ? <p>{children}</p> : null}
      {detail ? (
        <details className="more">
          <summary>View details</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  )
}

export function ErrorNotice({ error }: { error: GitRelayError }) {
  return <Notice tone="error" title={errorTitle(error.kind)} detail={error.detail}>{error.message}</Notice>
}

function errorTitle(kind: GitRelayError['kind']): string {
  switch (kind) {
    case 'auth':
      return 'Authentication failed'
    case 'permission':
      return 'Permission denied'
    case 'not_found':
      return 'Not found'
    case 'branch_missing':
      return 'Branch not found'
    case 'network':
      return 'Network problem'
    case 'rate_limit':
      return 'Rate limit reached'
    case 'conflict':
      return 'Merge conflict'
    case 'protected_branch':
      return 'Blocked by a branch rule'
    case 'refused':
      return 'GitHub refused the merge'
    case 'stale':
      return 'Branch changed'
    default:
      return 'Something went wrong'
  }
}
