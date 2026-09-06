import { canMerge, readinessLabel, relativeTime, type BranchStatus } from '../lib/status'

interface BranchRowProps {
  status: BranchStatus
  target: string
  repoUrl: string
  onMerge: (branch: string) => void
}

const PILL_TONE = {
  clean: 'ok',
  unverified: 'warn',
  nothing_to_merge: 'mute',
  missing: 'err',
} as const

export function BranchRow({ status, target, repoUrl, onMerge }: BranchRowProps) {
  const { comparison } = status
  const mergeable = canMerge(status.readiness)

  return (
    <div className={`branch${status.readiness === 'missing' ? ' is-missing' : ''}`}>
      <div className="branch-main">
        <div className="branch-name">
          <span className="mono">{status.name}</span>
          <span className={`pill ${PILL_TONE[status.readiness]}`}>
            {status.readiness === 'clean' ? '✓ ' : null}
            {readinessLabel(status.readiness, target)}
          </span>
        </div>

        {status.error ? (
          <div className="branch-meta" style={{ color: 'var(--danger)' }}>{status.error}</div>
        ) : comparison ? (
          <div className="branch-meta">
            <span className="counts">
              <span className={comparison.aheadBy ? 'ahead' : 'zero'}>
                {comparison.aheadBy} ahead
              </span>
              <span className={comparison.behindBy ? 'behind' : 'zero'}>
                {comparison.behindBy} behind
              </span>
            </span>
            {status.latestDate ? <span>· {relativeTime(status.latestDate)}</span> : null}
          </div>
        ) : (
          <div className="branch-meta"><span className="skeleton" style={{ width: 140 }} /></div>
        )}

        {status.latestMessage ? (
          <div className="branch-latest">
            Latest: <strong>{status.latestMessage}</strong>
          </div>
        ) : null}
      </div>

      <div className="branch-action">
        {mergeable ? (
          <button className="primary" onClick={() => onMerge(status.name)}>
            Merge to {target}
          </button>
        ) : status.readiness === 'missing' ? (
          <button type="button" disabled>View</button>
        ) : (
          <a
            className="btn-a"
            href={`${repoUrl}/tree/${encodeURIComponent(status.name)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            View
          </a>
        )}
      </div>
    </div>
  )
}
