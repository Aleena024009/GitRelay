import { describe, expect, it } from 'vitest'
import {
  branchSegment,
  compareHtmlUrl,
  isValidBranch,
  isValidOwner,
  isValidRepo,
  repoPath,
  safeGitHubUrl,
} from './validate'

describe('repository names cannot escape their API path', () => {
  it('accepts real names', () => {
    expect(repoPath({ owner: 'Aleena24', repo: 'CelerSCET' })).toBe('/repos/Aleena24/CelerSCET')
    expect(repoPath({ owner: 'a-b', repo: 'x.y_z-1' })).toBe('/repos/a-b/x.y_z-1')
  })

  it.each([
    '../../user',
    '..',
    'a/b',
    'owner?x=1',
    'owner#frag',
    'owner%2F..',
    '-leading',
    'trailing-',
    '',
  ])('rejects owner %j', (owner) => {
    expect(isValidOwner(owner)).toBe(false)
    expect(() => repoPath({ owner, repo: 'ok' })).toThrow()
  })

  it.each(['../../../etc/passwd', 'a/b', '..', '.', 'repo?x', 'repo name'])(
    'rejects repo %j',
    (repo) => {
      expect(isValidRepo(repo)).toBe(false)
      expect(() => repoPath({ owner: 'ok', repo })).toThrow()
    },
  )

  it('percent-encodes what it accepts', () => {
    // Dots are legal in repository names but must not walk the path.
    expect(repoPath({ owner: 'ok', repo: 'a.b' })).toBe('/repos/ok/a.b')
  })
})

describe('branch names', () => {
  it('accepts ordinary refs', () => {
    for (const name of ['dev', 'main', 'feature/login', 'release-1.2']) {
      expect(isValidBranch(name)).toBe(true)
    }
  })

  it.each([
    '../main',
    'a..b',
    'has space',
    'star*',
    'question?',
    'colon:x',
    'tilde~1',
    'caret^2',
    'back\\slash',
    '/leading',
    'trailing/',
    'double//slash',
    'ends.lock',
    'at@{x}',
  ])('rejects %j', (name) => {
    expect(isValidBranch(name)).toBe(false)
    expect(() => branchSegment(name)).toThrow()
  })

  it('encodes a slash so it cannot add a path segment', () => {
    expect(branchSegment('feature/login')).toBe('feature%2Flogin')
  })
})

describe('links built from untrusted URLs', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'http://github.com/a/b',
    'https://evil.example/a/b',
    'https://github.com.evil.example/a/b',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(safeGitHubUrl(url)).toBeNull()
  })

  it('allows a real GitHub https URL', () => {
    expect(safeGitHubUrl('https://github.com/Aleena24/CelerSCET/pull/955')).toBe(
      'https://github.com/Aleena24/CelerSCET/pull/955',
    )
  })

  it('builds compare links only from valid parts', () => {
    expect(compareHtmlUrl({ owner: 'a', repo: 'b' }, 'main', 'dev')).toBe(
      'https://github.com/a/b/compare/main...dev',
    )
    expect(compareHtmlUrl({ owner: 'a', repo: 'b' }, 'main', '../evil')).toBeNull()
  })
})
