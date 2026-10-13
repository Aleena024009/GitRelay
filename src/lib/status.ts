import type { ChangedFile, Comparison, Mergeability } from './github'

export type Readiness =
  | 'clean' // fast-forwardable: a merge cannot conflict
  | 'unverified' // diverged: GitHub decides at merge time
  | 'nothing_to_merge' // no commits on the branch that the target lacks
  | 'missing' // branch is configured but absent on GitHub

export interface BranchStatus {
  name: string
  /** The branch's tip on GitHub, used to detect changes mid-workflow. */
  sha: string | null
  readiness: Readiness
  comparison: Comparison | null
  latestMessage: string
  latestDate: string
  latestAuthor: string
  error: string | null
  /**
   * GitHub's own test-merge answer, read from an open pull request when one
   * exists. Only asked for diverged branches; anything else cannot conflict.
   */
  mergeability?: Mergeability | null
}

export function readinessOf(comparison: Comparison): Readiness {
  if (comparison.aheadBy === 0) return 'nothing_to_merge'
  return comparison.status === 'diverged' ? 'unverified' : 'clean'
}

export function readinessLabel(readiness: Readiness): string {
  switch (readiness) {
    case 'clean':
      return 'Ready to merge'
    case 'unverified':
      return 'Diverged'
    // Deliberately not "up to date": such a branch is often far behind the
    // target. What is true is that it holds nothing the target lacks.
    case 'nothing_to_merge':
      return 'Nothing to merge'
    case 'missing':
      return 'Branch not found'
  }
}

export function canMerge(readiness: Readiness): boolean {
  return readiness === 'clean' || readiness === 'unverified'
}

/**
 * The one-line version of what a pill means, for the row it sits on.
 *
 * "Diverged" is Git's word, not English, and a label nobody can act on is
 * worse than no label at all — so the row says what happened to the branches.
 */
export function readinessHint(
  readiness: Readiness,
  branch: string,
  target: string,
  comparison: Comparison | null,
): string {
  const behind = comparison?.behindBy ?? 0
  switch (readiness) {
    case 'unverified':
      return `${target} has ${plural(behind, 'commit')} that ${branch} does not, so this merge combines both sides and could conflict.`
    case 'clean':
      return `${target} has no commits ${branch} is missing, so this merge cannot conflict.`
    case 'nothing_to_merge':
      return `${target} already contains every commit on ${branch}.`
    case 'missing':
      return `${branch} is configured in Settings but does not exist on GitHub.`
  }
}

/**
 * The full explanation, for a tooltip or a dialog: what the state is, in terms
 * of both branches, and what it means for the merge about to happen.
 */
export function readinessExplanation(
  readiness: Readiness,
  branch: string,
  target: string,
  comparison: Comparison | null,
): string {
  const ahead = comparison?.aheadBy ?? 0
  const behind = comparison?.behindBy ?? 0
  switch (readiness) {
    case 'unverified':
      return (
        `Diverged means both branches moved on after the last commit they shared: ` +
        `${branch} has ${plural(ahead, 'commit')} that ${target} does not, and ` +
        `${target} has ${plural(behind, 'commit')} that ${branch} does not. ` +
        `Git has to combine the two sides rather than fast-forward, so the merge can conflict.`
      )
    case 'clean':
      return (
        `${branch} is ${plural(ahead, 'commit')} ahead of ${target}, and ${target} has ` +
        `nothing ${branch} is missing. The merge only moves ${target} forward, so it cannot conflict.`
      )
    case 'nothing_to_merge':
      return (
        `${target} already contains every commit on ${branch}` +
        (behind ? `, and ${branch} is ${plural(behind, 'commit')} behind it` : '') +
        `. There is nothing to merge.`
      )
    case 'missing':
      return `${branch} is configured in Settings but does not exist on GitHub, so nothing can be merged from it.`
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/* --------------------------------------------------------------------------
 * Contested files
 *
 * GitHub never names the files inside a conflict: the conflict only exists
 * inside a merge it refuses to keep, so there is no API that lists them. What
 * it does report is what each branch changed since the two parted, and a
 * conflict can only ever land in a file both sides touched. That intersection
 * is computed here — it is the exact, and short, list of files to look at, and
 * when it comes out empty there is nothing for Git to reconcile.
 * ------------------------------------------------------------------------ */

export interface ContestedFile {
  filename: string
  /** GitHub's word for the change on the branch being merged. */
  onSource: string
  /** GitHub's word for the change on the branch being merged into. */
  onTarget: string
  additions: number
  deletions: number
}

export function contestedFiles(
  sourceFiles: ChangedFile[],
  targetFiles: ChangedFile[],
): ContestedFile[] {
  const onTarget = new Map<string, ChangedFile>()
  for (const file of targetFiles) {
    onTarget.set(file.filename, file)
    // A rename touches both paths, and a collision on either one is real.
    if (file.previousFilename) onTarget.set(file.previousFilename, file)
  }

  const out: ContestedFile[] = []
  const seen = new Set<string>()
  for (const file of sourceFiles) {
    const other =
      onTarget.get(file.filename) ??
      (file.previousFilename ? onTarget.get(file.previousFilename) : undefined)
    if (!other || seen.has(file.filename)) continue
    seen.add(file.filename)
    out.push({
      filename: file.filename,
      onSource: file.status,
      onTarget: other.status,
      additions: file.additions,
      deletions: file.deletions,
    })
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename))
}

/* --------------------------------------------------------------------------
 * GitHub's own mergeability verdict
 *
 * `Readiness` above is inferred from a comparison. This is different: it is
 * the answer GitHub computed by actually test-merging the branches, and it is
 * worded the way GitHub words it in the web interface. Only a real conflict
 * blocks: failing checks and unsatisfied protection rules belong to the pull
 * request, not to whether the two branches merge, so they are reported and
 * left for GitHub to enforce at merge time.
 * ------------------------------------------------------------------------ */

export interface MergeabilitySummary {
  tone: 'ok' | 'warn' | 'err' | 'mute'
  /** Short pill text. */
  label: string
  /** One sentence of explanation, or '' when there is nothing to add. */
  detail: string
  /** True only when GitHub has determined the branches conflict. */
  blocking: boolean
}

/**
 * Renders a verdict for display, or null when GitHub has no verdict to give
 * and the caller should fall back to the comparison-derived readiness.
 */
export function summarizeMergeability(
  mergeability: Mergeability,
  source: string,
  target: string,
): MergeabilitySummary | null {
  switch (mergeability.kind) {
    case 'mergeable': {
      const base = `GitHub test-merged the branches for #${mergeability.pull.number}: ${source} merges into ${target} without conflicts.`
      return {
        tone: 'ok',
        label: 'Able to merge',
        detail:
          mergeability.state === 'blocked'
            ? `${base} A branch protection rule on ${target} may still refuse the merge.`
            : mergeability.state === 'unstable'
              ? `${base} Some checks on that pull request are failing, which does not affect whether the branches merge.`
              : base,
        blocking: false,
      }
    }
    case 'conflicting':
      return {
        tone: 'err',
        label: 'Conflicts',
        detail: `GitHub test-merged the branches for #${mergeability.pull.number} and found conflicting changes. ${source} cannot be merged into ${target} until they are resolved.`,
        blocking: true,
      }
    case 'computing':
      return {
        tone: 'mute',
        label: 'Checking…',
        detail: `GitHub is still working out whether #${mergeability.pull.number} merges cleanly. Refresh in a moment for its answer.`,
        blocking: false,
      }
    // Nothing GitHub-computed exists to show; the comparison stands on its own.
    case 'no_pull_request':
    case 'unavailable':
      return null
  }
}
