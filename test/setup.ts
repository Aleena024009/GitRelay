import { afterEach, beforeEach } from 'vitest'

/**
 * jsdom does not expose Web Storage under this Node version, and the storage
 * guarantees are exactly what these tests exist to check — skipping them was
 * not an option. This is a faithful in-memory `Storage`: `getItem` returns
 * null for a missing key, values are coerced to strings, and keys enumerate as
 * own properties so `Object.keys(localStorage)` behaves as it does in a
 * browser. Tests assert against this contract, not against a stub that agrees
 * with the implementation by construction.
 */
function createStorage(): Storage {
  const data: Record<string, string> = Object.create(null)

  const api = {
    getItem: (key: string): string | null => (String(key) in data ? data[String(key)] : null),
    setItem: (key: string, value: string): void => {
      data[String(key)] = String(value)
    },
    removeItem: (key: string): void => {
      delete data[String(key)]
    },
    clear: (): void => {
      for (const key of Object.keys(data)) delete data[key]
    },
    key: (index: number): string | null => Object.keys(data)[index] ?? null,
    get length(): number {
      return Object.keys(data).length
    },
  }

  return new Proxy(api, {
    get: (target, prop) =>
      prop in target ? target[prop as keyof typeof target] : data[prop as string],
    has: (target, prop) => prop in target || (prop as string) in data,
    ownKeys: () => Object.keys(data),
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && prop in data
        ? { value: data[prop], enumerable: true, configurable: true, writable: true }
        : undefined,
    set: (target, prop, value) => {
      if (prop in target) return false
      data[prop as string] = String(value)
      return true
    },
    deleteProperty: (_target, prop) => {
      delete data[prop as string]
      return true
    },
  }) as unknown as Storage
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const storage = createStorage()
  for (const target of [globalThis, globalThis.window].filter(Boolean)) {
    Object.defineProperty(target, name, {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}

install('localStorage')
install('sessionStorage')

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
