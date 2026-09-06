import { useEffect, useMemo, useState } from 'react'
import { getRepo, listBranches, type BranchRef } from '../lib/github'
import { asGitRelayError, GitRelayError } from '../lib/errors'
import { type Config } from '../lib/config'
import { ErrorNotice, Notice } from './Notice'

interface SettingsProps {
  token: string
  config: Config
  login: string | null
  onSave: (config: Config) => void
  onCancel: (() => void) | null
  onSignOut: () => void
}

export function Settings({ token, config, login, onSave, onCancel, onSignOut }: SettingsProps) {
  const [draft, setDraft] = useState<Config>(config)
  const [newBranch, setNewBranch] = useState('')
  const [remote, setRemote] = useState<BranchRef[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<GitRelayError | null>(null)
  const [checkedRepo, setCheckedRepo] = useState<string | null>(null)
  const [writable, setWritable] = useState<boolean | null>(null)

  const set = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const remoteNames = useMemo(() => new Set(remote?.map((b) => b.name)), [remote])

  // A repo the user has already typed in full is worth verifying immediately,
  // so the branch pickers can offer real names.
  useEffect(() => {
    setRemote(null)
    setCheckedRepo(null)
    setWritable(null)
  }, [draft.owner, draft.repo])

  async function verify() {
    const owner = draft.owner.trim()
    const repo = draft.repo.trim()
    if (!owner || !repo || checking) return
    setChecking(true)
    setCheckError(null)
    try {
      const info = await getRepo(token, { owner, repo })
      const branches = await listBranches(token, { owner, repo })
      setRemote(branches)
      setCheckedRepo(info.fullName)
      setWritable(info.permissions?.push ?? null)
    } catch (err) {
      setCheckError(asGitRelayError(err))
      setRemote(null)
      setCheckedRepo(null)
    } finally {
      setChecking(false)
    }
  }

  function addBranch(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (draft.devBranches.includes(trimmed)) return
    set('devBranches', [...draft.devBranches, trimmed])
    setNewBranch('')
  }

  function renameBranch(index: number, name: string) {
    set(
      'devBranches',
      draft.devBranches.map((b, i) => (i === index ? name : b)),
    )
  }

  function removeBranch(index: number) {
    set(
      'devBranches',
      draft.devBranches.filter((_, i) => i !== index),
    )
  }

  const owner = draft.owner.trim()
  const repo = draft.repo.trim()
  const canSave = Boolean(owner && repo && draft.devBranch.trim() && draft.prodBranch.trim())

  function save() {
    if (!canSave) return
    onSave({
      owner,
      repo,
      devBranch: draft.devBranch.trim(),
      prodBranch: draft.prodBranch.trim(),
      // Drop blanks left behind by renaming, and de-duplicate.
      devBranches: [...new Set(draft.devBranches.map((b) => b.trim()).filter(Boolean))],
    })
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 17, flex: 1 }}>Settings</h2>
        {login ? <span className="muted small-text">@{login}</span> : null}
      </div>

      <datalist id="remote-branches">
        {remote?.map((b) => <option key={b.name} value={b.name} />)}
      </datalist>

      <div className="form" style={{ marginTop: 18 }}>
        <div className="field-group">
          <label>Repository</label>
          <div className="row">
            <input
              type="text"
              placeholder="owner"
              aria-label="Repository owner"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.owner}
              onChange={(e) => set('owner', e.target.value)}
            />
            <input
              type="text"
              placeholder="repository"
              aria-label="Repository name"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.repo}
              onChange={(e) => set('repo', e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <button
              type="button"
              className="small"
              onClick={verify}
              disabled={!owner || !repo || checking}
            >
              {checking ? <span className="icon-btn"><span className="spinner" /> Checking…</span> : 'Check access'}
            </button>
            {checkedRepo ? (
              <span className="pill ok">✓ {checkedRepo}</span>
            ) : (
              <span className="hint">Verifies the repository and loads its branch names.</span>
            )}
          </div>
        </div>

        {checkError ? <ErrorNotice error={checkError} /> : null}
        {writable === false ? (
          <Notice tone="warn" title="Read-only access">
            Your token can read this repository but cannot write to it, so merges will fail. Give
            the token <strong>Contents: Read and write</strong> permission.
          </Notice>
        ) : null}

        <div className="row">
          <div className="field-group">
            <label htmlFor="devBranch">Development branch</label>
            <input
              id="devBranch"
              type="text"
              list="remote-branches"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.devBranch}
              onChange={(e) => set('devBranch', e.target.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="prodBranch">Production branch</label>
            <input
              id="prodBranch"
              type="text"
              list="remote-branches"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.prodBranch}
              onChange={(e) => set('prodBranch', e.target.value)}
            />
          </div>
        </div>

        <div className="field-group">
          <label>Developer branches</label>
          <span className="hint">
            Only the branches listed here appear on the main screen. Nothing is added
            automatically, and nothing is ever merged unless you select it.
          </span>

          {draft.devBranches.length ? (
            <div className="chip-list" style={{ marginTop: 4 }}>
              {draft.devBranches.map((name, i) => {
                const unknown = remote !== null && name.trim() !== '' && !remoteNames.has(name.trim())
                return (
                  <div className="chip" key={i}>
                    <input
                      type="text"
                      aria-label={`Developer branch ${i + 1}`}
                      autoCapitalize="none"
                      spellCheck={false}
                      value={name}
                      onChange={(e) => renameBranch(i, e.target.value)}
                      list="remote-branches"
                      style={{ background: 'transparent', border: 'none', padding: 0, fontWeight: 600 }}
                    />
                    {unknown ? <span className="pill warn">not on GitHub</span> : null}
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => removeBranch(i)}
                      aria-label={`Remove ${name}`}
                    >
                      Remove
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="empty" style={{ marginTop: 4 }}>No developer branches configured yet.</div>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="text"
              placeholder="Add a branch…"
              aria-label="New developer branch"
              list="remote-branches"
              autoCapitalize="none"
              spellCheck={false}
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addBranch(newBranch)
                }
              }}
            />
            <button
              type="button"
              className="flex-none"
              onClick={() => addBranch(newBranch)}
              disabled={!newBranch.trim()}
            >
              Add
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 4 }}>
          {onCancel ? (
            <button type="button" onClick={onCancel}>Cancel</button>
          ) : null}
          <button type="button" className="primary" onClick={save} disabled={!canSave}>
            Save
          </button>
        </div>

        <div className="center" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button type="button" className="ghost small danger" onClick={onSignOut}>
            Sign out and forget token
          </button>
        </div>
      </div>
    </div>
  )
}
