import {
  canMerge,
  readinessExplanation,
  readinessHint,
  readinessLabel,
  relativeTime,
  summarizeMergeability,
  type BranchStatus,
} from '../lib/status'
import { safeGitHubUrl } from '../lib/validate'
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
  const verdict = status.mergeability
    ? summarizeMergeability(status.mergeability, status.name, target)
    : null
  const pull =
    status.mergeability && 'pull' in status.mergeability ? status.mergeability.pull : null
  // A conflict GitHub has confirmed blocks the button: the merge would only be refused.
  const mergeable = canMerge(status.readiness) && !verdict?.blocking

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
          {verdict ? (
            <span className={`pill ${verdict.tone}`} title={verdict.detail}>
              {verdict.tone === 'ok' ? '✓ ' : null}
              {verdict.label}
            </span>
          ) : (
            <span
              className={`pill ${PILL_TONE[status.readiness]}`}
              title={readinessExplanation(status.readiness, status.name, target, comparison)}
            >
              {status.readiness === 'clean' ? '✓ ' : null}
              {readinessLabel(status.readiness)}
            </span>
          )}
        </div>

        {status.error ? (
          <div className="branch-meta is-error">{status.error}</div>
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
          <div className="branch-meta"><span className="skeleton w-130" /></div>
        )}

        {verdict ? (
          <div className={`branch-hint ${verdict.blocking ? 'is-error' : 'is-muted'}`}>{verdict.detail}</div>
        ) : status.readiness === 'unverified' && comparison ? (
          <div className="branch-hint">
            {readinessHint('unverified', status.name, target, comparison)}
          </div>
        ) : null}

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
        ) : verdict?.blocking && pull && safeGitHubUrl(pull.htmlUrl) ? (
          <a
            className="btn-a"
            href={safeGitHubUrl(pull.htmlUrl)!}
            target="_blank"
            rel="noreferrer noopener"
            title={`Resolve the conflicts in #${pull.number} on GitHub`}
          >
            Resolve <ExternalIcon />
          </a>
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
