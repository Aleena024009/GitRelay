/**
 * The only module in GitRelay that touches token storage.
 *
 * GitRelay is a static site with no backend, so there is nowhere to keep an
 * OAuth client secret and GitHub's device-flow endpoints do not send CORS
 * headers a browser can use. The token is therefore supplied by the user at
 * runtime and kept only in this browser — never in the source or the repo.
 *
 * Storage is `sessionStorage`, deliberately, and there is no "keep me signed
 * in". GitHub Pages project sites all share one origin: a user's
 * https://<user>.github.io serves /GitRelay/ alongside every other project
 * page they publish, and `localStorage` is keyed by origin with no regard for
 * path. A token in `localStorage` is therefore readable by script on *any* of
 * those sibling pages, and lives until something deletes it. `sessionStorage`
 * is scoped to a single tab and dies when that tab closes, which shrinks both
 * the window and the audience.
 *
 * This is a mitigation, not isolation. Same-origin script running in the same
 * tab can still read `sessionStorage`. Only a dedicated origin fixes that
 * properly; see SECURITY.md.
 */
const TOKEN_KEY = 'gitrelay.token.v1'

/**
 * Earlier builds offered "keep me signed in" and wrote the token to
 * `localStorage`, where it survives indefinitely. Anyone upgrading still has
 * that copy sitting in their browser, so it is deleted on first load. Removing
 * the feature is not enough on its own; the old value has to go too.
 */
function purgePersistedToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable (private mode, blocked cookies); nothing to purge */
  }
}

purgePersistedToken()

export function loadToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(token: string): void {
  purgePersistedToken()
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* nothing usable to store into; the caller keeps working from memory */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* already gone or unavailable */
  }
  purgePersistedToken()
}

export function hasToken(): boolean {
  return loadToken() !== null
}
