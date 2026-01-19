import { defineStore } from 'pinia'
import { ref, computed, onMounted } from 'vue'
import apiService from '../services/apiService'

/**
 * Pinia store for mounted Caddyfiles.
 *
 * Responsibilities:
 * - List mounted Caddyfiles defined via environment variables (metadata only)
 * - Fetch raw file content for each mounted Caddyfile from the backend
 * - Provide simple getters and helpers for components
 *
 * The store initializes when mounted (via `onMounted`) and exposes an
 * `initialize()` method for manual control.
 *
 * @returns {object} Pinia store with state, getters and actions
 */
export const useCaddyfileStore = defineStore('caddyFiles', () => {
  const mounted = ref([])
  const isLoading = ref(false)
  const error = ref(null)
  const isInitialized = ref(false)

  const getById = computed(() => id => mounted.value.find(m => m.id === id || m._id === id))
  const getCount = computed(() => mounted.value.length)
  const plainMounted = computed(() => JSON.parse(JSON.stringify(mounted.value)))

  /**
   * Initialize the store by fetching the mounted list and their contents.
   * Calls `fetchMounted()` then `fetchAllContents()` and sets `isInitialized`.
   * Safe to call multiple times; subsequent calls are no-ops if already initialized.
   * @returns {Promise<void>}
   */
  async function initialize() {
    if (isInitialized.value) return
    await fetchMounted()
    try { await fetchAllContents() } catch (e) { console.debug('caddyfile init content fetch failed', e) }
    isInitialized.value = true
  }

  /**
   * Fetch the list of mounted Caddyfiles (metadata) from the backend.
   * Normalizes each entry to include a `content` key (default `null`).
   * After populating `mounted` this also triggers fetching of each file's content.
   * @returns {Promise<Array>} Array of mounted entries or an empty array on failure
   */
  async function fetchMounted() {
    isLoading.value = true
    error.value = null
    try {
      const res = await apiService.get('/caddyfiles')
      if (res?.data?.success && Array.isArray(res.data.data)) {
        mounted.value = res.data.data.map(item => ({ ...item, content: item.content ?? null }))
        // After we populate the mounted list, fetch each file's content.
        try { await fetchAllContents() } catch (e) { console.debug('fetchMounted: fetchAllContents failed', e) }
        return mounted.value
      }
      console.warn('Unexpected mounted caddyfiles response', res && res.data)
      return []
    } catch (e) {
      error.value = e?.message || 'Failed to fetch mounted Caddyfiles'
      console.error('fetchMounted error', e)
      return []
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch metadata for a single mounted Caddyfile by id and merge it into state.
   * @param {string} id - The mounted Caddyfile id
   * @returns {Promise<Object|null>} The mounted entry or null if not found
   */
  async function fetchMountedById(id) {
    isLoading.value = true
    error.value = null
    try {
      const res = await apiService.get(`/caddyfiles/${encodeURIComponent(id)}`)
      if (res?.data?.success) {
        const item = { ...res.data.data, content: res.data.data.content ?? null }
        const idx = mounted.value.findIndex(m => m.id === item.id || m._id === item._id)
        if (idx !== -1) mounted.value[idx] = item
        else mounted.value.push(item)
        return item
      }
      return null
    } catch (e) {
      error.value = e?.message || `Failed to fetch mounted Caddyfile: ${id}`
      console.error('fetchMountedById error', e)
      return null
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch the raw content for a mounted Caddyfile from `/caddyfiles/:id/content`.
   * Stores the returned string under the `content` key of the matching mounted entry.
   * @param {string} id - The mounted Caddyfile id
   * @returns {Promise<string|null>} Raw content string or null on failure
   */
  async function fetchMountedContent(id) {
    isLoading.value = true
    error.value = null
    try {
      const res = await apiService.get(`/caddyfiles/${encodeURIComponent(id)}/content`, { responseType: 'text' })
      if (res && res.data !== undefined) {
        const content = res.data
        const idx = mounted.value.findIndex(m => m.id === id || m._id === id)
        if (idx !== -1) mounted.value[idx].content = content
        else mounted.value.push({ id, content })
        console.debug('Loaded content for', id)
        return content
      }
      return null
    } catch (e) {
      error.value = e?.message || `Failed to fetch content for ${id}`
      console.error('fetchMountedContent error', e)
      return null
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch contents for all mounted entries concurrently.
   * Returns an array of result objects { id, success, content?, error? }.
   * @returns {Promise<Array>} Results for each mounted file
   */
  async function fetchAllContents() {
    if (!Array.isArray(mounted.value) || mounted.value.length === 0) return []
    const tasks = mounted.value.map(m => {
      const id = m.id || m._id
      return fetchMountedContent(id).then(c => ({ id, success: true, content: c })).catch(err => ({ id, success: false, error: err }))
    })
    const results = await Promise.allSettled(tasks)
    return results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason })
  }

  /**
   * Validate mounted Caddyfiles on the backend (admin endpoint).
   * @returns {Promise<Object|null>} Validation report or null on failure
   */
  async function validateMounted() {
    isLoading.value = true
    error.value = null
    try {
      const res = await apiService.get('/caddyfiles/validate')
      return res?.data?.success ? res.data.data : null
    } catch (e) {
      error.value = e?.message || 'Failed to validate mounted Caddyfiles'
      console.error('validateMounted error', e)
      return null
    } finally {
      isLoading.value = false
    }
  }

  // Initialize when the store is mounted (consistent with other stores)
  onMounted(() => {
    initialize().catch(e => console.debug('caddyfile store init failed', e))
  })

  return {
    mounted,
    isLoading,
    error,
    isInitialized,
    plainMounted,
    getById,
    getCount,
    getContent(id) { const it = mounted.value.find(m => m.id === id || m._id === id); return it ? it.content : null },
    initialize,
    fetchMounted,
    fetchMountedById,
    fetchMountedContent,
    fetchAllContents,
    validateMounted
  }
})
