import type { Comparison } from './github'

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
