/**
 * SQLite column whitelist — prevents SQL injection via Object.keys(updateData)
 * AGENTS.md §7 C3: never interpolate `${key} = ?` without ALLOWED
 */

const ALLOWED = {
  caddy_servers: new Set(['name','apiUrl','apiPort','adminApiPath','active','tags','description','lastPinged','status','activeConfig','createdBy']),
  caddy_configs: new Set(['servers','name','format','jsonConfig','status','metadata','history']),
  users: new Set(['username','email','password','role','isActive','lastLogin']),
  api_keys: new Set(['name','permissions','isActive','lastUsed','expiresAt']),
};

function filterUpdateData(table, updateData) {
  const allowed = ALLOWED[table];
  if (!allowed) throw new Error(`Unknown table ${table}`);
  const filtered = {};
  for (const [k, v] of Object.entries(updateData)) {
    if (allowed.has(k)) {
      filtered[k] = v;
    } else {
      // Silently drop unknown columns — could also throw 400
      console.warn(`SQL whitelist dropped unknown column ${table}.${k}`);
    }
  }
  return filtered;
}

module.exports = { ALLOWED, filterUpdateData };
