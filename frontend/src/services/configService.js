/**
 * Configuration service for accessing environment variables and dynamic /config endpoint
 * Loads <frontend base url>/config at runtime and falls back to environment variables if not present
 */

let runtimeConfig = null

// Loads <frontend base url>/config and populates runtimeConfig
export async function loadConfig() {
  try {
    const configUrl = window.location.origin + '/config'
    console.log('[configService] Fetching config from', configUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(configUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) throw new Error('Failed to load ' + configUrl)
    const len = res.headers.get('content-length')
    if (len && parseInt(len, 10) > 10240) throw new Error('Config too large')
    runtimeConfig = await res.json()
    // Validate api_base_url immediately (H-02)
    if (runtimeConfig && runtimeConfig.api_base_url !== undefined) {
      const v = runtimeConfig.api_base_url
      if (typeof v !== 'string' || !v.startsWith('/api') || v.includes('://') || v.startsWith('//')) {
        console.warn('[configService] Invalid api_base_url from /config, ignoring:', v)
        delete runtimeConfig.api_base_url
      }
    }
    console.log('[configService] Loaded config:', runtimeConfig)
  } catch (e) {
    console.warn('[configService] Failed to load /config, falling back to env vars:', e)
    runtimeConfig = null
  }
}

function getConfigValue(key, envVar, fallback) {
  if (runtimeConfig && runtimeConfig[key] !== undefined) return runtimeConfig[key]
  if (import.meta.env[envVar] !== undefined) return import.meta.env[envVar]
  return fallback
}

// API Configuration — validates same-origin (H-02)
export function getApiBaseUrl() {
  const v = getConfigValue('api_base_url', 'VITE_API_BASE_URL', '/api/v1')
  if (typeof v !== 'string' || !v.startsWith('/api') || v.includes('://') || v.startsWith('//')) {
    console.warn('[configService] Invalid api_base_url blocked:', v)
    return '/api/v1'
  }
  return v
}

// Application Settings
export function getAppTitle() {
  return getConfigValue('app_name', 'VITE_APP_TITLE', 'Caddy Manager')
}

// Feature Flags
export function isDarkModeEnabled() {
  const val = getConfigValue('enable_dark_mode', 'VITE_ENABLE_DARK_MODE', 'false')
  return val === true || val === 'true'
}

// Timeout settings (these could be moved to .env if needed)
export const API_TIMEOUT = 30000 // 30 seconds
export const AUTH_TOKEN_KEY = 'auth_token'

// Configuration object for easier imports
const config = {
  API: {
    get BASE_URL() { return getApiBaseUrl() },
    TIMEOUT: API_TIMEOUT
  },
  APP: {
    get TITLE() { return getAppTitle() }
  },
  FEATURES: {
    get DARK_MODE() { return isDarkModeEnabled() }
  },
  STORAGE: {
    AUTH_TOKEN_KEY: AUTH_TOKEN_KEY
  }
}

export default config