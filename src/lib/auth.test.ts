import { describe, expect, it } from 'vitest'
import { clearToken, hasToken, loadToken, saveToken } from './auth'

const TOKEN = 'github_pat_11EXAMPLE0000000000_abcdefghijklmnopqrstuvwxyz0123456789'
const KEY = 'gitrelay.token.v1'

describe('token storage', () => {
  it('keeps the token in sessionStorage only', () => {
    saveToken(TOKEN)
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('never writes to localStorage under any key', () => {
    saveToken(TOKEN)
    const persisted = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '')
    expect(persisted.join('\n')).not.toContain(TOKEN)
    expect(localStorage.length).toBe(0)
  })

  it('purges a token left in localStorage by an older build', () => {
    // Simulate the previous "keep me signed in" behaviour.
    localStorage.setItem(KEY, TOKEN)
    saveToken(TOKEN)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN)
  })

  it('removes the token on sign out, from both stores', () => {
    localStorage.setItem(KEY, TOKEN)
    saveToken(TOKEN)
    clearToken()
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadToken()).toBeNull()
    expect(hasToken()).toBe(false)
  })

  it('reports no token when storage is empty', () => {
    expect(loadToken()).toBeNull()
    expect(hasToken()).toBe(false)
  })
})
