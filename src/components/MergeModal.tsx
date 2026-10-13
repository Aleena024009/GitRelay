import { useCallback, useEffect, useState } from 'react'
import {
  compareBranches,
  fastForwardBranch,
  getBranch,
  getMergeability,
  mergeBranch,
  type Comparison,
  type Mergeability,
  type MergeResult,
  type RepoRef,
} from '../lib/github'
import { asGitRelayError, GitRelayError } from '../lib/errors'
import {
  contestedFiles,
  readinessExplanation,
  readinessOf,
  relativeTime,
  summarizeMergeability,
  type ContestedFile,
} from '../lib/status'
import { safeGitHubUrl } from '../lib/validate'
import { Modal } from './Modal'
import { ErrorNotice, Notice } from './Notice'

interface MergeModalProps {
  repo: RepoRef
  repoUrl: string
  source: string
  target: string
  /** Wording differs for a release, but the safety path is identical. */
  isRelease?: boolean
  /**
   * Ask GitHub for its own mergeability verdict, the one its web interface
   * shows. It only has one where a pull request is open, so this is a bonus on
   * top of the comparison, never the thing the dialog depends on.
   */
  checkMergeability?: boolean
  /**
   * `merge` writes a merge commit on the target. `fast-forward` only ever
   * moves the target to the source's tip, creating no commit, and refuses
   * when the target has commits of its own rather than combining the two.
   */
  strategy?: 'merge' | 'fast-forward'
  onClose: () => void
  onMerged: (result: MergeResult | null, source: string, target: string) => void
}

interface Preview {
  comparison: Comparison
  sourceSha: string
  targetSha: string
  targetLatest: string
  targetDate: string
}

type Phase = 'loading' | 'ready' | 'merging' | 'conflict' | 'refused' | 'stale' | 'diverged'

export function MergeModal({
  repo,
  repoUrl,
  source,
  target,
  isRelease = false,
  checkMergeability = false,
  strategy = 'merge',
  onClose,
  onMerged,
}: MergeModalProps) {
  const fastForward = strategy === 'fast-forward'
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mergeability, setMergeability] = useState<Mergeability | null>(null)
  /** Files both branches changed; null while unknown. */
  const [contested, setContested] = useState<ContestedFile[] | null>(null)
  const [error, setError] = useState<GitRelayError | null>(null)

  /** Always pulls live state; a merge is never judged on cached information. */
  const load = useCallback(async (): Promise<Preview | null> => {
    const [sourceBranch, targetBranch, comparison] = await Promise.all([
      getBranch(repo, source),
      getBranch(repo, target),
      compareBranches(repo, target, source),
    ])
    return {
      comparison,
      sourceSha: sourceBranch.latest.sha,
      targetSha: targetBranch.latest.sha,
      targetLatest: targetBranch.latest.message,
      targetDate: targetBranch.latest.date,
    }
  }, [repo, source, target])

  const refresh = useCallback(
    async (nextPhase: Phase = 'ready') => {
      setPhase('loading')
      setError(null)
      setMergeability(null)
      setContested(null)
      let loaded: Preview | null
      try {
        loaded = await load()
        setPreview(loaded)
        setPhase(nextPhase)
      } catch (err) {
        setError(asGitRelayError(err))
        setPhase('ready')
        return
      }

      // Which files the two branches are both holding changes to. Only a
      // diverged pair has a second side to compare, so nothing else pays for
      // the extra request.
      if (loaded && loaded.comparison.status === 'diverged') {
        try {
          const reverse = await compareBranches(repo, source, target)
          setContested(contestedFiles(loaded.comparison.files, reverse.files))
        } catch {
          // Supporting detail. Failing to get it must not cost the summary.
          setContested(null)
        }
      } else {
        setContested([])
      }

      // Read-only and secondary: the summary above is already usable, and a
      // verdict GitHub cannot give simply leaves the comparison speaking.
      // A fast-forward cannot conflict, so a test-merge verdict has nothing to add.
      if (checkMergeability && !fastForward) {
        setMergeability(await getMergeability(repo, target, source))
      }
    },
    [load, checkMergeability, fastForward, repo, target, source],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function confirmMerge() {
    if (!preview || phase === 'merging') return
    setPhase('merging')
    setError(null)

    try {
      // Re-check immediately before writing: the branches may have moved while
      // this dialog was open, which would make the summary above a lie.
      const fresh = await load()
      if (
        !fresh ||
        fresh.sourceSha !== preview.sourceSha ||
        fresh.targetSha !== preview.targetSha
      ) {
        setPreview(fresh)
        // The file list belonged to the comparison that just went out of date.
        setContested(null)
        setPhase('stale')
        return
      }

      if (fresh.comparison.aheadBy === 0) {
        onMerged(null, source, target)
        return
      }

      if (fastForward) {
        // Checked here as well as by GitHub: a target with commits of its own
        // is reported, never merged into or overwritten.
        if (fresh.comparison.status !== 'ahead') {
          setPhase('diverged')
          return
        }
        onMerged(await fastForwardBranch(repo, target, fresh.sourceSha), source, target)
        return
      }

      const result = await mergeBranch(
        repo,
        target,
        source,
        `Merge branch '${source}' into ${target}\n\nMerged with GitRelay.`,
      )
      onMerged(result, source, target)
    } catch (err) {
      const e = asGitRelayError(err)
      setError(e)
      if (e.kind === 'conflict') {
        setPhase('conflict')
      } else if (e.kind === 'diverged') {
        // The target moved between the re-check and the write. GitHub
        // refused the update, so both branches are exactly as they were.
        setPhase('diverged')
      } else if (e.kind === 'protected_branch' || e.kind === 'refused') {
        // GitHub refused the write itself. Retrying cannot help, so the
        // dialog closes off the same way a conflict does.
        setPhase('refused')
      } else {
        setPhase('ready')
      }
    }
  }

  const cmp = preview?.comparison ?? null
  const readiness = cmp ? readinessOf(cmp) : null
  const verdict = mergeability ? summarizeMergeability(mergeability, source, target) : null
  const busy = phase === 'loading' || phase === 'merging'
  /** The target has commits the source lacks, so it cannot just be moved forward. */
  const cannotFastForward = fastForward && (phase === 'diverged' || cmp?.status === 'diverged')
  const blocked =
    phase === 'conflict' || phase === 'refused' || phase === 'stale' || cannotFastForward
  /** A conflict GitHub has actually confirmed, rather than one that is merely possible. */
  const conflicted = phase === 'conflict' || !!verdict?.blocking
  const canConfirm =
    !busy && !blocked && !!cmp && cmp.aheadBy > 0 && !error && !verdict?.blocking

  const title = isRelease ? `Release ${source} → ${target}` : `Merge ${source} → ${target}`

  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissable={phase !== 'merging'}
      head={
        <div className="modal-flow">
          <span className="muted">Source</span>
          <span className="mono"><strong>{source}</strong></span>
          <span className="arrow" aria-hidden="true">→</span>
          <span className="muted">Target</span>
          <span className="mono"><strong>{target}</strong></span>
        </div>
      }
      footer={
        <>
          <button onClick={onClose} disabled={phase === 'merging'}>
            {blocked ? 'Close' : 'Cancel'}
          </button>
          {phase === 'stale' ? (
            <button className="primary" onClick={() => void refresh()}>Review again</button>
          ) : (
            <button className="primary" onClick={() => void confirmMerge()} disabled={!canConfirm}>
              {phase === 'merging' ? (
                <span className="icon-btn">
                  <span className="spinner" /> {fastForward ? 'Updating…' : 'Merging…'}
                </span>
              ) : fastForward ? (
                `Fast-forward ${target} to ${source}`
              ) : isRelease ? (
                `Merge ${source} → ${target}`
              ) : (
                `Merge to ${target}`
              )}
            </button>
          )}
        </>
      }
    >
      {phase === 'loading' ? (
        <div className="stack">
          <span className="skeleton w-60" />
          <span className="skeleton w-85" />
          <span className="skeleton w-40" />
          <p className="muted small-text">Fetching the current state of both branches…</p>
        </div>
      ) : null}

      {phase === 'stale' ? (
        <Notice tone="warn" title="Branches changed while this was open">
          <span className="mono">{source}</span> or <span className="mono">{target}</span> moved on
          GitHub since this summary was built. Nothing was merged. Review the updated changes
          before continuing.
        </Notice>
      ) : null}

      {phase === 'conflict' ? (
        <Notice
          tone="error"
          title="Merge conflict"
          detail={error?.detail}
        >
          <span className="mono">{source}</span> cannot currently be merged into{' '}
          <span className="mono">{target}</span> because the branches have conflicting changes.
          Nothing was changed — <span className="mono">{target}</span> and{' '}
          <span className="mono">{source}</span> are both exactly as they were.
          {contested?.length
            ? ' The conflict is in one of the files listed below; resolve it in Git, then try again.'
            : ' Resolve the conflict in Git, then try again.'}
        </Notice>
      ) : null}

      {cannotFastForward && !busy ? (
        <Notice tone="error" title="Branches have diverged">
          <span className="mono">{target}</span> has{' '}
          {cmp?.behindBy ? `${cmp.behindBy} commit${cmp.behindBy === 1 ? '' : 's'}` : 'commits'} that{' '}
          <span className="mono">{source}</span> does not, so it cannot be moved forward to{' '}
          <span className="mono">{source}</span> without discarding them. GitRelay never does that,
          and nothing was changed. Bring <span className="mono">{source}</span> up to date with{' '}
          <span className="mono">{target}</span> first, then try again.
        </Notice>
      ) : null}

      {phase === 'refused' && error ? (
        <>
          <ErrorNotice error={error} />
          <p className="muted small-text">
            {error.kind === 'protected_branch' ? (
              <>
                A merge commit pushed straight to <span className="mono">{target}</span> is not
                what that rule allows.{' '}
              </>
            ) : null}
            <a
              href={`${repoUrl}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open a pull request
            </a>{' '}
            from <span className="mono">{source}</span> into <span className="mono">{target}</span>{' '}
            on GitHub and merge it there.
          </p>
        </>
      ) : error && phase !== 'conflict' && phase !== 'diverged' ? (
        <ErrorNotice error={error} />
      ) : null}

      {cmp && !busy ? (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="n">{cmp.totalCommits}</div>
              <div className="k">{cmp.totalCommits === 1 ? 'Commit' : 'Commits'}</div>
            </div>
            <div className="stat">
              <div className="n">{cmp.files.length}{cmp.filesTruncated ? '+' : ''}</div>
              <div className="k">Files</div>
            </div>
            <div className="stat">
              <div className={`n${cmp.additions ? ' add' : ''}`}>+{cmp.additions}</div>
              <div className="k">Added</div>
            </div>
            <div className="stat">
              <div className={`n${cmp.deletions ? ' del' : ''}`}>−{cmp.deletions}</div>
              <div className="k">Removed</div>
            </div>
          </div>

          {!blocked && verdict && cmp.aheadBy > 0 ? (
            <Notice
              tone={verdict.blocking ? 'error' : verdict.tone === 'ok' ? 'success' : 'info'}
              title={verdict.blocking ? 'GitHub reports conflicts' : verdict.label}
            >
              {verdict.detail}
              {mergeability && 'pull' in mergeability && safeGitHubUrl(mergeability.pull.htmlUrl) ? (
                <>
                  {' '}
                  <a
                    href={safeGitHubUrl(mergeability.pull.htmlUrl)!}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    View #{mergeability.pull.number}
                  </a>
                  .
                </>
              ) : null}
            </Notice>
          ) : null}

          {!blocked && !verdict && readiness === 'clean' ? (
            <Notice tone="success" title="No conflicts possible">
              <span className="mono">{target}</span> has no commits that{' '}
              <span className="mono">{source}</span> is missing, so this merge cannot conflict.
            </Notice>
          ) : null}

          {!blocked && !verdict && !fastForward && readiness === 'unverified' ? (
            <Notice tone="warn" title="Branches have diverged">
              {readinessExplanation('unverified', source, target, cmp)} GitHub checks for real
              conflicts when you confirm, and changes nothing if it finds any.
            </Notice>
          ) : null}

          {cmp.aheadBy === 0 ? (
            <Notice tone="info" title="Nothing to merge">
              <span className="mono">{target}</span> already contains everything on{' '}
              <span className="mono">{source}</span>.
            </Notice>
          ) : null}

          {cmp.aheadBy > 0 && contested ? (
            contested.length === 0 ? (
              readiness === 'unverified' ? (
                <Notice tone="success" title="No overlapping files">
                  The branches diverged, but nothing <span className="mono">{source}</span> changed
                  was also changed on <span className="mono">{target}</span> since they parted, so
                  there is nothing for Git to reconcile.
                </Notice>
              ) : null
            ) : (
              <div className="section-block">
                <div className="subhead">
                  {conflicted ? 'Where the conflict is' : 'Changed on both branches'}
                </div>
                <p className="muted small-text">
                  {conflicted ? (
                    <>
                      A conflict can only be inside a file both branches changed, so it is in one of
                      these {contested.length === 1 ? 'files' : `${contested.length} files`}.
                    </>
                  ) : (
                    <>
                      {contested.length === 1 ? 'This file was' : `These ${contested.length} files were`}{' '}
                      changed on <span className="mono">{source}</span> and on{' '}
                      <span className="mono">{target}</span>. Git merges them on its own unless the
                      same lines moved on both sides — a conflict, if there is one, can only be here.
                    </>
                  )}
                </p>
                <ul className="file-list">
                  {contested.map((f) => (
                    <li key={f.filename}>
                      <a
                        className="fname mono"
                        href={`${repoUrl}/blob/${encodeURIComponent(source)}/${f.filename
                          .split('/')
                          .map(encodeURIComponent)
                          .join('/')}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {f.filename}
                      </a>
                      <span className="where" title={`${source}: ${f.onSource} · ${target}: ${f.onTarget}`}>
                        {f.onSource === f.onTarget
                          ? f.onSource
                          : `${f.onSource} / ${f.onTarget}`}
                      </span>
                    </li>
                  ))}
                </ul>
                {cmp.filesTruncated ? (
                  <p className="muted small-text">
                    GitHub caps each comparison at 300 files, so this list may be incomplete.
                  </p>
                ) : null}
              </div>
            )
          ) : null}

          <div className="section-block">
            <div className="subhead">Current {target}</div>
            <div className="muted small-text">
              <span className="mono">{preview?.targetSha.slice(0, 7)}</span> ·{' '}
              {preview?.targetLatest}
              {preview?.targetDate ? ` · ${relativeTime(preview.targetDate)}` : ''}
            </div>
          </div>

          {cmp.commits.length ? (
            <div className="section-block">
              <div className="subhead">
                Commits that will be merged
                {cmp.totalCommits > cmp.commits.length
                  ? ` (showing ${cmp.commits.length} of ${cmp.totalCommits})`
                  : ''}
              </div>
              <ul className="commit-list">
                {cmp.commits.slice().reverse().map((c) => (
                  <li key={c.sha}>
                    <span className="sha mono">{c.sha.slice(0, 7)}</span>
                    <span className="msg">{c.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {cmp.files.length ? (
            <details className="more" open={cmp.files.length <= 10}>
              <summary>
                {cmp.files.length}{cmp.filesTruncated ? '+' : ''} file
                {cmp.files.length === 1 ? '' : 's'} changed
              </summary>
              <ul className="file-list">
                {cmp.files.map((f) => (
                  <li key={f.filename}>
                    <span className="fname mono">{f.filename}</span>
                    <span className="delta mono">
                      <span className={f.additions ? 'a' : ''}>+{f.additions}</span>{' '}
                      <span className={f.deletions ? 'd' : ''}>−{f.deletions}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {cmp.filesTruncated ? (
                <p className="muted small-text">
                  GitHub limits this list to 300 files.{' '}
                  <a
                    href={`${repoUrl}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    View the full diff on GitHub
                  </a>
                  .
                </p>
              ) : null}
            </details>
          ) : null}

          <p className="muted small-text">
            {fastForward ? (
              <>
                This moves <span className="mono">{target}</span> to the latest commit on{' '}
                <span className="mono">{source}</span> without creating a merge commit, so both
                branches end up on the same commit.
              </>
            ) : (
              <>
                This creates a merge commit on <span className="mono">{target}</span>.
              </>
            )}{' '}
            <span className="mono">{source}</span> is not modified or deleted.
          </p>
        </>
      ) : null}
    </Modal>
  )
}
