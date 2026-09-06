import type { Comparison, Mergeability } from './github'

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
