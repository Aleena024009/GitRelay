import { useEffect, useMemo, useState } from 'react'
import { getRepo, listBranches, type BranchRef } from '../lib/github'
import { isValidBranch, isValidOwner, isValidRepo } from '../lib/validate'
import { asGitRelayError, GitRelayError } from '../lib/errors'
import { type Config } from '../lib/config'
import { ErrorNotice, Notice } from './Notice'
import { CloseIcon } from './Icons'

interface SettingsProps {
  config: Config
  login: string | null
  onSave: (config: Config) => void
  onCancel: (() => void) | null
  onSignOut: () => void
}

export function Settings({ config, login, onSave, onCancel, onSignOut }: SettingsProps) {
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

  const suggestions = useMemo(() => {
    if (!remote) return []
    const taken = new Set([
      ...draft.devBranches.map((b) => b.trim()),
      draft.devBranch.trim(),
      draft.prodBranch.trim(),
    ])
    return remote.map((b) => b.name).filter((n) => !taken.has(n))
  }, [remote, draft.devBranches, draft.devBranch, draft.prodBranch])

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
      const info = await getRepo({ owner, repo })
      const branches = await listBranches({ owner, repo })
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
  const devBranch = draft.devBranch.trim()
  const prodBranch = draft.prodBranch.trim()
  const trackedBranches = [...new Set(draft.devBranches.map((b) => b.trim()).filter(Boolean))]

  // Every one of these values ends up in a GitHub API path. They are checked
  // again in the API client, but rejecting them here means an invalid name is
  // never stored and the reason is visible while it is being typed.
  const invalid: string | null = !owner
    ? null
    : !isValidOwner(owner)
      ? `"${owner}" is not a valid GitHub owner name.`
      : repo && !isValidRepo(repo)
        ? `"${repo}" is not a valid repository name.`
        : devBranch && !isValidBranch(devBranch)
          ? `"${devBranch}" is not a valid branch name.`
          : prodBranch && !isValidBranch(prodBranch)
            ? `"${prodBranch}" is not a valid branch name.`
            : (trackedBranches.find((b) => !isValidBranch(b))
                ? `"${trackedBranches.find((b) => !isValidBranch(b))}" is not a valid branch name.`
                : null)

  const canSave = Boolean(owner && repo && devBranch && prodBranch) && !invalid

  function save() {
    if (!canSave) return
    onSave({ owner, repo, devBranch, prodBranch, devBranches: trackedBranches })
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Settings</h2>
        {login ? <span className="muted small-text nowrap">@{login}</span> : null}
      </div>

      <datalist id="remote-branches">
        {remote?.map((b) => <option key={b.name} value={b.name} />)}
      </datalist>

      <div className="form">
        <div className="field-group">
          <label>Repository</label>
          <div className="row tight">
            <div className="field-group">
              <label htmlFor="owner" className="sublabel">Owner</label>
              <input
                id="owner"
                type="text"
                placeholder="e.g. octocat"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={draft.owner}
                onChange={(e) => set('owner', e.target.value)}
              />
            </div>
            <div className="field-group">
              <label htmlFor="repo" className="sublabel">Repository name</label>
              <input
                id="repo"
                type="text"
                placeholder="e.g. my-project"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={draft.repo}
                onChange={(e) => set('repo', e.target.value)}
              />
            </div>
          </div>

          {owner || repo ? (
            <span className="hint">
              Will use{' '}
              <span className="mono text-strong">
                {owner || 'owner'}/{repo || 'repository'}
              </span>
              {owner && repo && owner === repo
                ? ' — both boxes match, which is unusual. The second box is the repository name, not the owner again.'
                : ''}
            </span>
          ) : null}

          <div className="row-inline">
            <button
              type="button"
              className="subtle small"
              onClick={verify}
              disabled={!owner || !repo || checking}
            >
              {checking ? (
                <span className="btn-inner"><span className="spinner" /> Checking…</span>
              ) : (
                'Check access'
              )}
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
              autoCorrect="off"
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
              autoCorrect="off"
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
            <div className="chip-list">
              {draft.devBranches.map((name, i) => {
                const unknown =
                  remote !== null && name.trim() !== '' && !remoteNames.has(name.trim())
                return (
                  <div className="chip" key={i}>
                    <input
                      type="text"
                      className="chip-input mono"
                      aria-label={`Developer branch ${i + 1}`}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      list="remote-branches"
                      value={name}
                      onChange={(e) => renameBranch(i, e.target.value)}
                    />
                    {unknown ? <span className="pill warn">not on GitHub</span> : null}
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => removeBranch(i)}
                      title={`Remove ${name}`}
                      aria-label={`Remove ${name}`}
                    >
                      <CloseIcon size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="empty">No developer branches configured yet.</div>
          )}

          <div className="row-inline nowrap">
            <input
              type="text"
              placeholder="Add a branch…"
              aria-label="New developer branch"
              list="remote-branches"
              autoCapitalize="none"
              autoCorrect="off"
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
              className="subtle"
              onClick={() => addBranch(newBranch)}
              disabled={!newBranch.trim()}
            >
              Add
            </button>
          </div>

          {suggestions.length ? (
            <div className="field-group gap-7">
              <span className="hint">Branches in this repository — tap to add:</span>
              <div className="suggest-row">
                {suggestions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="subtle small suggest mono"
                    onClick={() => addBranch(name)}
                  >
                    + {name}
                  </button>
                ))}
              </div>
            </div>
          ) : remote && !suggestions.length && draft.devBranches.length ? (
            <span className="hint">Every branch in this repository is already accounted for.</span>
          ) : null}
        </div>

        {invalid ? (
          <Notice tone="warn" title="Cannot save yet">
            {invalid} GitRelay puts these names straight into GitHub API
            requests, so only names GitHub itself accepts are allowed.
          </Notice>
        ) : null}

        <div className="row">
          {onCancel ? (
            <button type="button" className="subtle" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="button" className="primary" onClick={save} disabled={!canSave}>
            Save
          </button>
        </div>

        <div className="divider" />
        <div className="center">
          <button type="button" className="danger-text small" onClick={onSignOut}>
            Sign out and forget token
          </button>
        </div>
      </div>
    </div>
  )
}
