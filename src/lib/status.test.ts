/**
 * The wording and the file intersection are the whole point of these helpers:
 * a merge is confirmed on what they say, so what they say is pinned down here.
 */
import { describe, expect, it } from 'vitest'
import type { ChangedFile, Comparison } from './github'
import {
  contestedFiles,
  readinessExplanation,
  readinessHint,
  readinessLabel,
  readinessOf,
} from './status'

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    status: 'diverged',
    aheadBy: 3,
    behindBy: 2,
    totalCommits: 3,
    commits: [],
    files: [],
    filesTruncated: false,
    additions: 0,
    deletions: 0,
    baseSha: 'base',
    ...overrides,
  }
}

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: 'modified', additions: 1, deletions: 1, ...overrides }
}

describe('readiness wording', () => {
  it('spells out what "diverged" means in terms of both branches', () => {
    const text = readinessExplanation('unverified', 'feature', 'dev', comparison())
    expect(text).toContain('both branches moved on')
    expect(text).toContain('feature has 3 commits that dev does not')
    expect(text).toContain('dev has 2 commits that feature does not')
    expect(text).toContain('can conflict')
  })

  it('pluralises a single commit', () => {
    const text = readinessExplanation(
      'unverified',
      'feature',
      'dev',
      comparison({ aheadBy: 1, behindBy: 1 }),
    )
    expect(text).toContain('feature has 1 commit that dev does not')
    expect(text).not.toContain('1 commits')
  })

  it('says a clean merge cannot conflict', () => {
    const cmp = comparison({ status: 'ahead', behindBy: 0 })
    expect(readinessOf(cmp)).toBe('clean')
    expect(readinessExplanation('clean', 'feature', 'dev', cmp)).toContain('cannot conflict')
  })

  it('gives every readiness a hint, and never leaves the label unexplained', () => {
    for (const readiness of ['clean', 'unverified', 'nothing_to_merge', 'missing'] as const) {
      expect(readinessLabel(readiness)).not.toBe('')
      expect(readinessHint(readiness, 'feature', 'dev', comparison()).length).toBeGreaterThan(10)
      expect(readinessExplanation(readiness, 'feature', 'dev', comparison()).length).toBeGreaterThan(10)
    }
  })

  it('survives a missing comparison rather than printing undefined', () => {
    const text = readinessExplanation('missing', 'feature', 'dev', null)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })
})

describe('contestedFiles', () => {
  it('keeps only the files both branches changed', () => {
    const result = contestedFiles(
      [file('src/app.ts'), file('src/only-source.ts')],
      [file('src/app.ts'), file('docs/only-target.md')],
    )
    expect(result.map((f) => f.filename)).toEqual(['src/app.ts'])
  })

  it('is empty when the branches touched different files', () => {
    expect(contestedFiles([file('a.ts')], [file('b.ts')])).toEqual([])
  })

  it('reports how each side changed the file', () => {
    const [entry] = contestedFiles(
      [file('a.ts', { status: 'modified', additions: 4, deletions: 2 })],
      [file('a.ts', { status: 'removed' })],
    )
    expect(entry).toMatchObject({
      filename: 'a.ts',
      onSource: 'modified',
      onTarget: 'removed',
      additions: 4,
      deletions: 2,
    })
  })

  it('catches a rename on one side colliding with the old path on the other', () => {
    const renamed = file('src/new.ts', { status: 'renamed', previousFilename: 'src/old.ts' })
    expect(contestedFiles([renamed], [file('src/old.ts')])).toHaveLength(1)
    expect(contestedFiles([file('src/old.ts')], [renamed])).toHaveLength(1)
  })

  it('lists each file once, in path order', () => {
    const result = contestedFiles(
      [file('z.ts'), file('a.ts'), file('a.ts')],
      [file('z.ts'), file('a.ts')],
    )
    expect(result.map((f) => f.filename)).toEqual(['a.ts', 'z.ts'])
  })

  it('has nothing to contest when either side changed nothing', () => {
    expect(contestedFiles([], [file('a.ts')])).toEqual([])
    expect(contestedFiles([file('a.ts')], [])).toEqual([])
  })
})
