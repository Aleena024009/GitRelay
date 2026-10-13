import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  compareBranches,
  getBranch,
  getMergeability,
  listBranches,
  type Mergeability,
  type MergeResult,
} from './lib/github'
import { asGitRelayError, GitRelayError } from './lib/errors'
import { emptyConfig, isConfigured, loadConfig, saveConfig, type Config } from './lib/config'
import { clearToken, hasToken, saveToken } from './lib/auth'
import { useInstall } from './lib/install'
import { showNotification, useNotifications } from './lib/notify'
import { safeGitHubUrl } from './lib/validate'
import {
  canMerge,
  readinessExplanation,
  readinessOf,
  relativeTime,
  summarizeMergeability,
  type BranchStatus,
} from './lib/status'
import { SignIn } from './components/SignIn'
import { Settings } from './components/Settings'
import { BranchRow } from './components/BranchRow'
import { MergeModal } from './components/MergeModal'
import { InstallModal } from './components/InstallModal'
import { ErrorNotice, Notice } from './components/Notice'
import { DownloadIcon, RefreshIcon, SettingsIcon } from './components/Icons'

interface MergeTarget {
  source: string
  target: string
  isRelease: boolean
  strategy: 'merge' | 'fast-forward'
}

/** What a refresh last saw of a branch, so the next one can tell what changed. */
interface Seen {
  sha: string | null
  aheadBy: number
  conflicting: boolean
}

/** How often an open GitRelay checks GitHub while notifications are on. */
const POLL_MS = 2 * 60 * 1000
/** Coming back to the app refreshes it, unless it refreshed this recently. */
const STALE_MS = 60 * 1000

interface Success {
  source: string
  target: string
  result: MergeResult | null
  at: string
}

export default function App() {
  // Only whether a token exists lives in React state; the value itself stays
  // in the auth module, so it never reaches props, state or a devtools panel.
  const [signedIn, setSignedIn] = useState<boolean>(() => hasToken())
  const [login, setLogin] = useState<string | null>(null)
  const [config, setConfig] = useState<Config>(() => loadConfig())
  const [showSettings, setShowSettings] = useState(false)
  const [showInstall, setShowInstall] = useState(false)

  const [statuses, setStatuses] = useState<BranchStatus[] | null>(null)
  const [release, setRelease] = useState<BranchStatus | null>(null)
  const [mergeability, setMergeability] = useState<Mergeability | null>(null)
  /**
   * How many files the production-only commits change, or null when unknown.
   * Zero means they are merge commits that carry no code — history, not work.
   */
  const [prodOnlyFiles, setProdOnlyFiles] = useState<number | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [loadingRelease, setLoadingRelease] = useState(false)
  const [error, setError] = useState<GitRelayError | null>(null)
  const [pending, setPending] = useState<MergeTarget | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)

  const install = useInstall()
  const notifications = useNotifications()
  /** Last refresh's view of the branches; null until the first one lands. */
  const seen = useRef<{ key: string; branches: Map<string, Seen>; release: Seen | null } | null>(null)
  const lastRefresh = useRef(0)
  const configured = isConfigured(config)
  const loading = loadingBranches || loadingRelease
  /** Identifies the current refresh so a superseded one cannot write state. */
  const generation = useRef(0)
  const repoRef = useMemo(
    () => ({ owner: config.owner, repo: config.repo }),
    [config.owner, config.repo],
  )
  // Scheme is hardcoded and both segments are encoded, so this can never
  // become a `javascript:` URL or escape the repository path.
  const repoUrl = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`

  /**
   * Ends the session in place, used when GitHub rejects the token mid-use so
   * the sign-in screen can still say why. Every piece of repository state is
   * dropped, and any refresh still in flight is told it no longer counts.
   */
  const endSession = useCallback(() => {
    clearToken()
    generation.current++
    seen.current = null
    setSignedIn(false)
    setLogin(null)
    setStatuses(null)
    setRelease(null)
    setMergeability(null)
    setProdOnlyFiles(null)
    setPending(null)
    setSuccess(null)
    setShowSettings(false)
  }, [])

  /**
   * Signing out reloads the app, so nothing from the last session — branch
   * state, an open dialog, a request still in flight — outlives the token.
   */
  const signOut = useCallback(() => {
    clearToken()
    window.location.reload()
  }, [])

  /**
   * Notifies about what changed since the last refresh. The first refresh of
   * a repository only records what it saw: everything is "new" to it.
   */
  const noticeChanges = useCallback(
    (branches: BranchStatus[] | null, rel: BranchStatus | null) => {
      const key = `${config.owner}/${config.repo}:${config.devBranch}>${config.prodBranch}`
      const prev = seen.current?.key === key ? seen.current : null
      const next = { key, branches: new Map(prev?.branches), release: prev?.release ?? null }
      // Only worth interrupting someone who is not already looking at the app.
      const away = document.visibilityState === 'hidden' || !document.hasFocus()
      const say = (title: string, body: string, tag: string) => {
        if (prev && away) void showNotification(title, body, tag)
      }

      for (const b of branches ?? []) {
        if (b.error || !b.comparison) continue
        const now: Seen = {
          sha: b.sha,
          aheadBy: b.comparison.aheadBy,
          conflicting: b.mergeability?.kind === 'conflicting',
        }
        const was = prev?.branches.get(b.name)
        if (was && now.sha !== was.sha && now.aheadBy > 0) {
          say(
            `${b.name} has new commits`,
            `${b.latestAuthor}: ${b.latestMessage}\n${
              b.readiness === 'clean'
                ? `Ready to merge into ${config.devBranch}.`
                : `Diverged from ${config.devBranch}; the merge may conflict.`
            }`,
            `branch:${b.name}`,
          )
        }
        if (was && now.conflicting && !was.conflicting) {
          say(
            `${b.name} conflicts with ${config.devBranch}`,
            `GitHub found conflicting changes. Resolve them before merging.`,
            `conflict:${b.name}`,
          )
        }
        next.branches.set(b.name, now)
      }

      if (rel?.comparison && !rel.error) {
        const now: Seen = { sha: rel.sha, aheadBy: rel.comparison.aheadBy, conflicting: false }
        const was = prev?.release
        if (was && now.sha !== was.sha && now.aheadBy > 0) {
          say(
            `${config.devBranch} is ready to release`,
            `${now.aheadBy} commit${now.aheadBy === 1 ? '' : 's'} on ${config.devBranch} not yet on ${config.prodBranch}.`,
            'release',
          )
        }
        next.release = now
      }

      seen.current = next
    },
    [config.owner, config.repo, config.devBranch, config.prodBranch],
  )

  /** Builds one branch's status from live GitHub state. */
  const statusFor = useCallback(
    async (name: string, exists: boolean, sha: string | null): Promise<BranchStatus> => {
      const base: BranchStatus = {
        name,
        sha,
        readiness: 'missing',
        comparison: null,
        latestMessage: '',
        latestDate: '',
        latestAuthor: '',
        error: null,
      }

      if (!exists) {
        return { ...base, error: `This branch no longer exists in ${config.owner}/${config.repo}.` }
      }

      try {
        const [branch, comparison] = await Promise.all([
          getBranch(repoRef, name),
          compareBranches(repoRef, config.devBranch, name),
        ])
        const readiness = readinessOf(comparison)
        // A diverged branch might conflict. When it has an open pull request,
        // GitHub has already test-merged it, so its answer is shown on the row
        // directly instead of only after a merge is attempted.
        const mergeability =
          readiness === 'unverified'
            ? await getMergeability(repoRef, config.devBranch, name, { attempts: 2 })
            : null
        return {
          ...base,
          sha: branch.latest.sha,
          readiness,
          mergeability,
          comparison,
          latestMessage: branch.latest.message,
          latestDate: branch.latest.date,
          latestAuthor: branch.latest.authorName,
        }
      } catch (err) {
        return { ...base, error: asGitRelayError(err).message }
      }
    },
    [signedIn, repoRef, config.devBranch, config.owner, config.repo],
  )

  /**
   * Developer branches → dev. One listing tells us which configured branches
   * still exist, so a deleted branch is reported plainly instead of as a stack
   * of 404s.
   */
  const refreshBranches = useCallback(
    async (run: number) => {
      setLoadingBranches(true)
      try {
        const remote = await listBranches(repoRef)
        const shaByName = new Map(remote.map((b) => [b.name, b.sha]))
        const branchStatuses = await Promise.all(
          config.devBranches.map((name) =>
            statusFor(name, shaByName.has(name), shaByName.get(name) ?? null),
          ),
        )
        if (run !== generation.current) return
        setStatuses(branchStatuses)
        noticeChanges(branchStatuses, null)
      } catch (err) {
        if (run !== generation.current) return
        const e = asGitRelayError(err)
        setError(e)
        if (e.kind === 'auth') endSession()
      } finally {
        if (run === generation.current) setLoadingBranches(false)
      }
    },
    [signedIn, repoRef, config.devBranches, statusFor, endSession, noticeChanges],
  )

  /**
   * dev → prod. This asks GitHub about exactly these two branches and nothing
   * else: whether the release can go out must never depend on the repository's
   * other branches, on their state, or on how many of them there are.
   */
  const refreshRelease = useCallback(
    async (run: number) => {
      setLoadingRelease(true)
      const base: BranchStatus = {
        name: config.devBranch,
        sha: null,
        readiness: 'missing',
        comparison: null,
        latestMessage: '',
        latestDate: '',
        latestAuthor: '',
        error: null,
      }
      try {
        // Settled rather than raced, so a missing branch is named precisely
        // instead of the comparison implicating both of them.
        const [dev, prod, compared] = await Promise.allSettled([
          getBranch(repoRef, config.devBranch),
          getBranch(repoRef, config.prodBranch),
          compareBranches(repoRef, config.prodBranch, config.devBranch),
        ])
        if (dev.status === 'rejected') throw dev.reason
        if (prod.status === 'rejected') throw prod.reason
        if (compared.status === 'rejected') throw compared.reason

        const branch = dev.value
        const comparison = compared.value
        if (run !== generation.current) return
        const nextRelease: BranchStatus = {
          ...base,
          sha: branch.latest.sha,
          readiness: readinessOf(comparison),
          comparison,
          latestMessage: branch.latest.message,
          latestDate: branch.latest.date,
          latestAuthor: branch.latest.authorName,
        }
        setRelease(nextRelease)
        noticeChanges(null, nextRelease)

        // What the production-only commits actually change. Old release merge
        // commits add commits to count but no code, and that is worth saying.
        if (comparison.behindBy > 0) {
          const reverse = await compareBranches(
            repoRef,
            config.devBranch,
            config.prodBranch,
          ).catch(() => null)
          if (run !== generation.current) return
          setProdOnlyFiles(reverse ? reverse.files.length : null)
        }

        // Second stage: GitHub's own verdict, which it may take a few seconds
        // to compute. The commit counts above must not wait on it.
        const verdict = await getMergeability(
          repoRef,
          config.prodBranch,
          config.devBranch,
        )
        if (run !== generation.current) return
        setMergeability(verdict)
      } catch (err) {
        if (run !== generation.current) return
        const e = asGitRelayError(err)
        setRelease({ ...base, error: e.message })
        if (e.kind === 'auth') endSession()
      } finally {
        if (run === generation.current) setLoadingRelease(false)
      }
    },
    [signedIn, repoRef, config.devBranch, config.prodBranch, endSession, noticeChanges],
  )

  const refresh = useCallback(async () => {
    if (!signedIn || !configured) return
    const run = ++generation.current
    lastRefresh.current = Date.now()
    setError(null)
    setMergeability(null)
    setProdOnlyFiles(null)
    // Deliberately independent: neither half may hold up or veto the other.
    await Promise.all([refreshBranches(run), refreshRelease(run)])
  }, [signedIn, configured, refreshBranches, refreshRelease])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Coming back to the app shows current state, not what it saw when it was
  // left. With notifications on, it also keeps checking while in the background.
  useEffect(() => {
    if (!signedIn || !configured) return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current > STALE_MS) {
        void refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    const poll = notifications.enabled ? window.setInterval(() => void refresh(), POLL_MS) : null
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (poll !== null) window.clearInterval(poll)
    }
  }, [signedIn, configured, refresh, notifications.enabled])

  function handleSignedIn(newToken: string, user: string) {
    saveToken(newToken)
    setSignedIn(true)
    setLogin(user)
    if (!configured) setShowSettings(true)
  }

  function handleSaveConfig(next: Config) {
    saveConfig(next)
    setConfig(next)
    setShowSettings(false)
    setStatuses(null)
    setRelease(null)
    setMergeability(null)
    setProdOnlyFiles(null)
  }

  function handleMerged(result: MergeResult | null, source: string, target: string) {
    setPending(null)
    setSuccess({ source, target, result, at: new Date().toISOString() })
    void refresh()
  }

  const installButton = (
    <button
      className="icon-button"
      onClick={() => setShowInstall(true)}
      title={install.isInstalled ? 'App installed' : 'Download app'}
      aria-label={install.isInstalled ? 'App installed' : 'Download app'}
    >
      <DownloadIcon />
    </button>
  )

  const installModal = showInstall ? (
    <InstallModal
      platform={install.platform}
      browser={install.browser}
      canPrompt={install.canPrompt}
      isInstalled={install.isInstalled}
      onInstall={install.promptInstall}
      onClose={() => setShowInstall(false)}
    />
  ) : null

  if (!signedIn) {
    return (
      <Shell actions={installButton}>
        <SignIn onSignedIn={handleSignedIn} />
        {installModal}
      </Shell>
    )
  }

  if (showSettings || !configured) {
    return (
      <Shell actions={installButton}>
        <Settings
          config={configured ? config : { ...emptyConfig, ...config }}
          login={login}
          onSave={handleSaveConfig}
          onCancel={configured ? () => setShowSettings(false) : null}
          onSignOut={signOut}
          notifications={notifications}
        />
        {installModal}
      </Shell>
    )
  }

  const releaseCmp = release?.comparison ?? null
  // GitHub's own verdict when it has one; otherwise the comparison stands.
  const verdict = mergeability
    ? summarizeMergeability(mergeability, config.devBranch, config.prodBranch)
    : null
  // A release only ever fast-forwards production, so a diverged pair is never
  // released: combining the two sides is left to an explicit merge into dev.
  const releaseDiverged = releaseCmp?.status === 'diverged'
  const canRelease = release
    ? canMerge(release.readiness) && !releaseDiverged && !verdict?.blocking
    : false
  const devBehind = !!releaseCmp && releaseCmp.behindBy > 0

  return (
    <Shell
      actions={
        <>
          <button
            className={`icon-button${loading ? ' is-busy' : ''}`}
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh branch status"
            aria-label="Refresh branch status"
          >
            {loading ? <span className="spinner" /> : <RefreshIcon />}
          </button>
          <button
            className="icon-button"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon />
          </button>
          {installButton}
        </>
      }
    >
      <div className="repo-bar">
        <div className="field">
          <span className="label">Repository</span>
          <span className="value mono">
            <a href={repoUrl} target="_blank" rel="noreferrer noopener">
              {config.owner}/{config.repo}
            </a>
          </span>
        </div>
        <div className="field">
          <span className="label">Development</span>
          <span className="value mono">{config.devBranch}</span>
        </div>
        <div className="field">
          <span className="label">Production</span>
          <span className="value mono">{config.prodBranch}</span>
        </div>
      </div>

      {success ? (
        <div className="notice-row">
          <Notice
            tone="success"
            title={
              !success.result
                ? 'Already up to date'
                : success.result.kind === 'fast-forward'
                  ? 'Fast-forwarded'
                  : 'Successfully merged'
            }
          >
            {success.result ? (
              <>
                <span className="mono">{success.source}</span> →{' '}
                <span className="mono">{success.target}</span> ·{' '}
                {safeGitHubUrl(success.result.htmlUrl) ? (
                  <a
                    href={safeGitHubUrl(success.result.htmlUrl)!}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono"
                  >
                    {success.result.sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="mono">{success.result.sha.slice(0, 7)}</span>
                )}{' '}
                · {relativeTime(success.at)}.{' '}
                {success.result.kind === 'fast-forward' ? (
                  <>
                    <span className="mono">{success.target}</span> now points at the same commit as{' '}
                    <span className="mono">{success.source}</span>; no merge commit was created.
                  </>
                ) : (
                  <>
                    <span className="mono">{success.source}</span> was not modified.
                  </>
                )}
              </>
            ) : (
              <>
                <span className="mono">{success.target}</span> already contained everything on{' '}
                <span className="mono">{success.source}</span>. Nothing was changed.
              </>
            )}
          </Notice>
        </div>
      ) : null}

      {error ? (
        <div className="notice-row">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      <div className="section-title">
        <span>Developer branches</span>
        <span className="spacer" />
        {statuses ? <span className="count">{statuses.length}</span> : null}
      </div>

      {!statuses && loading ? (
        <div className="branch-list">
          {[0, 1, 2].map((i) => (
            <div className="branch" key={i}>
              <div className="branch-main stack">
                <span className="skeleton w-38" />
                <span className="skeleton w-58" />
              </div>
            </div>
          ))}
        </div>
      ) : statuses && statuses.length === 0 ? (
        <div className="empty">
          No developer branches configured yet.
          <div className="empty-action">
            <button className="subtle small" onClick={() => setShowSettings(true)}>
              Add branches
            </button>
          </div>
        </div>
      ) : (
        <div className="branch-list">
          {statuses?.map((status) => (
            <BranchRow
              key={status.name}
              status={status}
              target={config.devBranch}
              repoUrl={repoUrl}
              onMerge={(source) => {
                setSuccess(null)
                setPending({ source, target: config.devBranch, isRelease: false, strategy: 'merge' })
              }}
            />
          ))}
        </div>
      )}

      <div className="release">
        <div className="release-head">
          <span className="release-flow">
            <span className="mono">{config.devBranch}</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="mono">{config.prodBranch}</span>
          </span>
          {release?.error ? (
            <span className="pill err">{release.error}</span>
          ) : releaseCmp ? (
            <>
              <span className="counts">
                <span className={`c ahead${releaseCmp.aheadBy ? '' : ' zero'}`}>
                  {releaseCmp.aheadBy} ahead
                </span>
                <span className={`c behind${releaseCmp.behindBy ? '' : ' zero'}`}>
                  {releaseCmp.behindBy} behind
                </span>
              </span>
              {releaseCmp.aheadBy === 0 ? (
                <span className="pill mute">Nothing to release</span>
              ) : releaseDiverged ? (
                <span className="pill warn">Diverged</span>
              ) : verdict ? (
                <span className={`pill ${verdict.tone}`}>
                  {verdict.tone === 'ok' ? '✓ ' : null}
                  {verdict.label}
                </span>
              ) : releaseCmp.status === 'diverged' ? (
                <span className="pill warn">Diverged</span>
              ) : (
                <span className="pill ok">✓ Ready</span>
              )}
            </>
          ) : (
            <span className="skeleton w-110" />
          )}
        </div>

        {releaseCmp && releaseDiverged ? (
          <p className="release-verdict muted small-text">
            {readinessExplanation('unverified', config.devBranch, config.prodBranch, releaseCmp)}{' '}
            {prodOnlyFiles === 0
              ? `${config.prodBranch}'s extra commits change no files — they are merge commits from earlier releases. `
              : ''}
            A release only moves {config.prodBranch} forward, so merge {config.prodBranch} into{' '}
            {config.devBranch} first; the release can then fast-forward.
          </p>
        ) : releaseCmp && releaseCmp.aheadBy > 0 ? (
          verdict ? <p className="release-verdict muted small-text">{verdict.detail}</p> : null
        ) : releaseCmp && devBehind ? (
          <p className="release-verdict muted small-text">
            {prodOnlyFiles === 0
              ? `${config.devBranch} and ${config.prodBranch} hold identical code. The ${releaseCmp.behindBy} commits only on ${config.prodBranch} change no files — they are merge commits left by earlier releases. Update ${config.devBranch} to match ${config.prodBranch} to clear them.`
              : `${config.prodBranch} has ${releaseCmp.behindBy} commits that ${config.devBranch} does not${
                  prodOnlyFiles ? `, changing ${prodOnlyFiles} file${prodOnlyFiles === 1 ? '' : 's'}` : ''
                }. Update ${config.devBranch} to match ${config.prodBranch} so the next release can fast-forward.`}
          </p>
        ) : null}
        {releaseCmp && devBehind ? (
          <button
            className="subtle small block release-sync"
            onClick={() => {
              setSuccess(null)
              setPending({
                source: config.prodBranch,
                target: config.devBranch,
                isRelease: false,
                // dev with nothing of its own can simply move forward; dev with
                // work of its own needs production merged in, never overwritten.
                strategy: releaseCmp.aheadBy === 0 ? 'fast-forward' : 'merge',
              })
            }}
          >
            {releaseCmp.aheadBy === 0
              ? `Update ${config.devBranch} to match ${config.prodBranch}`
              : `Merge ${config.prodBranch} into ${config.devBranch}`}
          </button>
        ) : null}
        <button
          className="primary block"
          disabled={!canRelease}
          onClick={() => {
            setSuccess(null)
            setPending({
              source: config.devBranch,
              target: config.prodBranch,
              isRelease: true,
              strategy: 'fast-forward',
            })
          }}
        >
          Release {config.devBranch} → {config.prodBranch}
        </button>
      </div>

      {pending ? (
        <MergeModal
          repo={repoRef}
          repoUrl={repoUrl}
          source={pending.source}
          target={pending.target}
          isRelease={pending.isRelease}
          strategy={pending.strategy}
          checkMergeability
          onClose={() => setPending(null)}
          onMerged={handleMerged}
        />
      ) : null}
      {installModal}
    </Shell>
  )
}

function Shell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="app">
      <header className={`header${scrolled ? ' scrolled' : ''}`}>
        <img className="logo" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" />
        <h1>GitRelay</h1>
        <div className="header-actions">{actions}</div>
      </header>
      {children}
    </div>
  )
}
