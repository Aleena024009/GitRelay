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
import { safeGitHubUrl } from './lib/validate'
import {
  canMerge,
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
}

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
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [loadingRelease, setLoadingRelease] = useState(false)
  const [error, setError] = useState<GitRelayError | null>(null)
  const [pending, setPending] = useState<MergeTarget | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)

  const install = useInstall()
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

  const signOut = useCallback(() => {
    clearToken()
    setSignedIn(false)
    setLogin(null)
    setStatuses(null)
    setRelease(null)
    setMergeability(null)
    setShowSettings(false)
  }, [])

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
        return {
          ...base,
          sha: branch.latest.sha,
          readiness: readinessOf(comparison),
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
      } catch (err) {
        if (run !== generation.current) return
        const e = asGitRelayError(err)
        setError(e)
        if (e.kind === 'auth') signOut()
      } finally {
        if (run === generation.current) setLoadingBranches(false)
      }
    },
    [signedIn, repoRef, config.devBranches, statusFor, signOut],
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
        setRelease({
          ...base,
          sha: branch.latest.sha,
          readiness: readinessOf(comparison),
          comparison,
          latestMessage: branch.latest.message,
          latestDate: branch.latest.date,
          latestAuthor: branch.latest.authorName,
        })

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
        if (e.kind === 'auth') signOut()
      } finally {
        if (run === generation.current) setLoadingRelease(false)
      }
    },
    [signedIn, repoRef, config.devBranch, config.prodBranch, signOut],
  )

  const refresh = useCallback(async () => {
    if (!signedIn || !configured) return
    const run = ++generation.current
    setError(null)
    setMergeability(null)
    // Deliberately independent: neither half may hold up or veto the other.
    await Promise.all([refreshBranches(run), refreshRelease(run)])
  }, [signedIn, configured, refreshBranches, refreshRelease])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
  const canRelease = release ? canMerge(release.readiness) && !verdict?.blocking : false

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
            title={success.result ? 'Successfully merged' : 'Already up to date'}
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
                · {relativeTime(success.at)}. <span className="mono">{success.source}</span> was
                not modified.
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
                setPending({ source, target: config.devBranch, isRelease: false })
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

        {verdict && releaseCmp && releaseCmp.aheadBy > 0 ? (
          <p className="release-verdict muted small-text">{verdict.detail}</p>
        ) : null}
        <button
          className="primary block"
          disabled={!canRelease}
          onClick={() => {
            setSuccess(null)
            setPending({ source: config.devBranch, target: config.prodBranch, isRelease: true })
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
          checkMergeability={pending.isRelease}
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
