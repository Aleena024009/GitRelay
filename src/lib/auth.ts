/**
 * GitRelay is a static site with no backend, so there is nowhere to keep an
 * OAuth client secret and GitHub's device-flow endpoints do not send CORS
 * headers a browser can use. The token is therefore supplied by the user at
 * runtime and kept only in this browser — never in the source or the repo.
 */
const TOKEN_KEY = 'gitrelay.token.v1'

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(token: string, remember: boolean): void {
  clearToken()
  const store = remember ? localStorage : sessionStorage
  store.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage can be unavailable in private modes; nothing to clean up then */
  }
}
