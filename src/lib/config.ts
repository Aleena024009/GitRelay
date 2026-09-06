export interface Config {
  owner: string
  repo: string
  devBranch: string
  prodBranch: string
  /** Branches the user has explicitly chosen to track. Never auto-populated. */
  devBranches: string[]
}

const CONFIG_KEY = 'gitrelay.config.v1'

export const emptyConfig: Config = {
  owner: '',
  repo: '',
  devBranch: 'dev',
  prodBranch: 'main',
  devBranches: [],
}

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return emptyConfig
    const parsed = JSON.parse(raw) as Partial<Config>
    return {
      owner: parsed.owner ?? '',
      repo: parsed.repo ?? '',
      devBranch: parsed.devBranch || 'dev',
      prodBranch: parsed.prodBranch || 'main',
      devBranches: Array.isArray(parsed.devBranches) ? parsed.devBranches : [],
    }
  } catch {
    return emptyConfig
  }
}

export function saveConfig(config: Config): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

export function isConfigured(config: Config): boolean {
  return Boolean(config.owner && config.repo && config.devBranch && config.prodBranch)
}
