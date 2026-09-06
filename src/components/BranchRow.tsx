import { canMerge, readinessLabel, relativeTime, type BranchStatus } from '../lib/status'
import { ArrowDownIcon, ArrowUpIcon, ExternalIcon } from './Icons'

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
    <div
      className={[
        'branch',
        status.readiness === 'clean' ? 'is-ready' : '',
        status.readiness === 'missing' ? 'is-missing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="branch-main">
        <div className="branch-name">
          <span className="mono">{status.name}</span>
          <span className={`pill ${PILL_TONE[status.readiness]}`}>
            {status.readiness === 'clean' ? '✓ ' : null}
            {readinessLabel(status.readiness)}
          </span>
        </div>

        {status.error ? (
          <div className="branch-meta" style={{ color: 'var(--danger)' }}>{status.error}</div>
        ) : comparison ? (
          <div className="branch-meta">
            <span className="counts">
              <span className={`c ahead${comparison.aheadBy ? '' : ' zero'}`}>
                <ArrowUpIcon />
                {comparison.aheadBy}
              </span>
              <span className={`c behind${comparison.behindBy ? '' : ' zero'}`}>
                <ArrowDownIcon />
                {comparison.behindBy}
              </span>
            </span>
            {status.latestDate ? (
              <>
                <span className="dot" aria-hidden="true">•</span>
                <span>{relativeTime(status.latestDate)}</span>
              </>
            ) : null}
          </div>
        ) : (
          <div className="branch-meta"><span className="skeleton" style={{ width: 130 }} /></div>
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
          <button className="subtle" disabled>Unavailable</button>
        ) : (
          <a
            className="btn-a"
            href={`${repoUrl}/tree/${encodeURIComponent(status.name)}`}
            target="_blank"
            rel="noreferrer noopener"
            title={`Open ${status.name} on GitHub`}
          >
            View <ExternalIcon />
          </a>
        )}
      </div>
    </div>
  )
}
