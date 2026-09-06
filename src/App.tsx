import { useCallback, useEffect, useMemo, useState } from 'react'
import { compareBranches, getBranch, listBranches, type MergeResult } from './lib/github'
import { asGitRelayError, GitRelayError } from './lib/errors'
import { emptyConfig, isConfigured, loadConfig, saveConfig, type Config } from './lib/config'
import { clearToken, loadToken, saveToken } from './lib/auth'
import { canMerge, readinessOf, relativeTime, type BranchStatus } from './lib/status'
import { SignIn } from './components/SignIn'
import { Settings } from './components/Settings'
import { BranchRow } from './components/BranchRow'
import { MergeModal } from './components/MergeModal'
import { ErrorNotice, Notice } from './components/Notice'

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
  const [token, setToken] = useState<string | null>(() => loadToken())
  const [login, setLogin] = useState<string | null>(null)
  const [config, setConfig] = useState<Config>(() => loadConfig())
  const [showSettings, setShowSettings] = useState(false)

  const [statuses, setStatuses] = useState<BranchStatus[] | null>(null)
  const [release, setRelease] = useState<BranchStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<GitRelayError | null>(null)
  const [pending, setPending] = useState<MergeTarget | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)

  const configured = isConfigured(config)
  const repoRef = useMemo(() => ({ owner: config.owner, repo: config.repo }), [config.owner, config.repo])
  const repoUrl = `https://github.com/${config.owner}/${config.repo}`

  const signOut = useCallback(() => {
    clearToken()
    setToken(null)
    setLogin(null)
    setStatuses(null)
    setRelease(null)
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
          getBranch(token!, repoRef, name),
          compareBranches(token!, repoRef, config.devBranch, name),
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
    [token, repoRef, config.devBranch, config.owner, config.repo],
  )

  const refresh = useCallback(async () => {
    if (!token || !configured) return
    setLoading(true)
    setError(null)
    try {
      // One listing tells us which configured branches still exist, so a
      // deleted branch is reported plainly instead of as a stack of 404s.
      const remote = await listBranches(token, repoRef)
      const shaByName = new Map(remote.map((b) => [b.name, b.sha]))

      const [branchStatuses, releaseStatus] = await Promise.all([
        Promise.all(
          config.devBranches.map((name) =>
            statusFor(name, shaByName.has(name), shaByName.get(name) ?? null),
          ),
        ),
        (async (): Promise<BranchStatus> => {
          const base: BranchStatus = {
            name: config.devBranch,
            sha: shaByName.get(config.devBranch) ?? null,
            readiness: 'missing',
            comparison: null,
            latestMessage: '',
            latestDate: '',
            latestAuthor: '',
            error: null,
          }
          if (!shaByName.has(config.devBranch) || !shaByName.has(config.prodBranch)) {
            const missing = !shaByName.has(config.devBranch) ? config.devBranch : config.prodBranch
            return { ...base, error: `Branch "${missing}" was not found in this repository.` }
          }
          try {
            const [branch, comparison] = await Promise.all([
              getBranch(token, repoRef, config.devBranch),
              compareBranches(token, repoRef, config.prodBranch, config.devBranch),
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
        })(),
      ])

      setStatuses(branchStatuses)
      setRelease(releaseStatus)
    } catch (err) {
      const e = asGitRelayError(err)
      setError(e)
      if (e.kind === 'auth') signOut()
    } finally {
      setLoading(false)
    }
  }, [token, configured, repoRef, config.devBranches, config.devBranch, config.prodBranch, statusFor, signOut])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function handleSignedIn(newToken: string, remember: boolean, user: string) {
    saveToken(newToken, remember)
    setToken(newToken)
    setLogin(user)
    if (!configured) setShowSettings(true)
  }

  function handleSaveConfig(next: Config) {
    saveConfig(next)
    setConfig(next)
    setShowSettings(false)
    setStatuses(null)
    setRelease(null)
  }

  function handleMerged(result: MergeResult | null, source: string, target: string) {
    setPending(null)
    setSuccess({ source, target, result, at: new Date().toISOString() })
    void refresh()
  }

  if (!token) {
    return (
      <Shell>
        <SignIn onSignedIn={handleSignedIn} />
      </Shell>
    )
  }

  if (showSettings || !configured) {
    return (
      <Shell>
        <Settings
          token={token}
          config={configured ? config : { ...emptyConfig, ...config }}
          login={login}
          onSave={handleSaveConfig}
          onCancel={configured ? () => setShowSettings(false) : null}
          onSignOut={signOut}
        />
      </Shell>
    )
  }

  const releaseCmp = release?.comparison ?? null
  const canRelease = release ? canMerge(release.readiness) : false

  return (
    <Shell
      actions={
        <>
          <button className="ghost small" onClick={() => void refresh()} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Refresh'}
          </button>
          <button className="ghost small" onClick={() => setShowSettings(true)}>Settings</button>
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
        <Notice
          tone="success"
          title={success.result ? 'Successfully merged' : 'Already up to date'}
        >
          {success.result ? (
            <>
              <span className="mono">{success.source}</span> → <span className="mono">{success.target}</span>
              {' · '}
              <a href={success.result.htmlUrl} target="_blank" rel="noreferrer noopener" className="mono">
                {success.result.sha.slice(0, 7)}
              </a>
              {' · '}
              {relativeTime(success.at)}
              {'. '}
              <span className="mono">{success.source}</span> was not modified.
            </>
          ) : (
            <>
              <span className="mono">{success.target}</span> already contained everything on{' '}
              <span className="mono">{success.source}</span>. Nothing was changed.
            </>
          )}
        </Notice>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}

      <div className="section-title">
        <span>Developer branches</span>
        <span className="spacer" />
        {statuses ? <span>{statuses.length}</span> : null}
      </div>

      {!statuses && loading ? (
        <div className="branch-list">
          {[0, 1, 2].map((i) => (
            <div className="branch" key={i}>
              <div className="branch-main stack">
                <span className="skeleton" style={{ width: '35%' }} />
                <span className="skeleton" style={{ width: '55%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : statuses && statuses.length === 0 ? (
        <div className="empty">
          No developer branches configured.{' '}
          <button className="ghost small" onClick={() => setShowSettings(true)}>Add branches</button>
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
        <div className="release-summary">
          <span>
            <span className="mono">{config.devBranch}</span> →{' '}
            <span className="mono">{config.prodBranch}</span>
          </span>
          {release?.error ? (
            <span className="pill err">{release.error}</span>
          ) : releaseCmp ? (
            <>
              <span className="counts">
                <span className={releaseCmp.aheadBy ? 'ahead' : 'zero'}>
                  {releaseCmp.aheadBy} ahead
                </span>
                <span className={releaseCmp.behindBy ? 'behind' : 'zero'}>
                  {releaseCmp.behindBy} behind
                </span>
              </span>
              {releaseCmp.aheadBy === 0 ? (
                <span className="pill mute">Nothing to release</span>
              ) : releaseCmp.status === 'diverged' ? (
                <span className="pill warn">Diverged — conflicts possible</span>
              ) : (
                <span className="pill ok">✓ Ready to release</span>
              )}
            </>
          ) : (
            <span className="skeleton" style={{ width: 120 }} />
          )}
        </div>
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
          token={token}
          repo={repoRef}
          repoUrl={repoUrl}
          source={pending.source}
          target={pending.target}
          isRelease={pending.isRelease}
          onClose={() => setPending(null)}
          onMerged={handleMerged}
        />
      ) : null}
    </Shell>
  )
}

function Shell({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="app">
      <header className="header">
        <img className="logo" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" />
        <h1>GitRelay</h1>
        {actions}
      </header>
      {children}
    </div>
  )
}
