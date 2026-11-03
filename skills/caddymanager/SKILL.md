---
name: caddymanager
description: Read, patch, validate and apply Caddy JSON configuration through a Caddy Manager MCP endpoint. Use when asked to inspect or change Caddy routes, upstreams, TLS or headers managed by Caddy Manager.
---

# Caddy Manager MCP

Caddy Manager exposes a small, opt-in MCP server for editing Caddy JSON configs.
It is **stateless JSON-RPC 2.0 over HTTP** — no SSE, no sessions. The backend
owns the safety rails: ownership checks, SSRF policy, audit logging, and
snapshot/rollback on apply.

## Connection

| | |
|---|---|
| Endpoint | `POST http://<caddy-manager-host>/api/v1/mcp` (through the frontend proxy), or `http://<host>:3000/api/v1/mcp` when the backend port is published |
| Auth | `Authorization: Bearer <api key>` |
| Key scope | `read` for inspection tools, `write` for patch/save/apply |
| Accounts | JWT login tokens are rejected — this endpoint only accepts API keys |

The endpoint is disabled unless the operator sets `MCP_ENABLED=true`. If you get
`404 Not found`, MCP is off. If you get `403 Origin is not allowed`, a browser
client is calling from an origin that is not in `MCP_ALLOWED_ORIGIN` (non-browser
clients send no `Origin` header and are unaffected).

Example client entry (adapt to your client's format — some use `"type": "http"`,
others `"transport": "http"`):

```json
{
  "mcpServers": {
    "caddymanager": {
      "type": "http",
      "url": "http://192.168.1.20/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${CADDYMANAGER_API_KEY}" }
    }
  }
}
```

Create the key in **API Keys** in the Caddy Manager UI (or `POST /api/v1/apikeys`).
Use a dedicated key with the smallest permission set that works, and revoke it
when the agent is retired.

## Tools

| Tool | Permission | Purpose |
|---|---|---|
| `list_servers` | read | Servers visible to the key, with IDs and admin URLs |
| `list_configs` | read | Saved config metadata for a server (no JSON bodies) |
| `read_config` | read | Summary + `sha256` digest of a saved config, or the live config of a server |
| `patch_config` | read + write | Reads the saved config, then applies RFC 6902 ops; rejected unless the result parses |
| `save_config` | write | Persist a full config document (creating one, or replacing a saved one) |
| `validate_config` | read | Run Caddy's `validate_only` against the config's server(s) |
| `apply_config` | write | Apply to server(s); requires `confirm=true` unless `dryRun=true` |

### `read_config`

- `configId` → saved config. Returns `summary`, `digest`, metadata.
- `serverId` → live config straight from Caddy. Add `save=true` to persist it as a
  saved config (this is how you turn a live config into something patchable). That
  write needs the `write` permission.
- `full=true` returns the raw JSON in addition to the summary.
- `summary=false` returns only the raw JSON.
- Provide exactly one of `configId` / `serverId`.

### `patch_config`

Arguments: `configId`, `operations` (1–100 RFC 6902 operations),
optional `expectedDigest` (the `digest` returned by `read_config`).

This tool requires both `read` and `write`, because it reads the saved config
through the REST API before applying the patch.

The patch is rejected if any pointer does not exist, an operation is unsupported,
the document would stop being a JSON object, or the operation touches
`__proto__` / `constructor` / `prototype`. Nothing is written on rejection.

### `validate_config`

Arguments: `configId`, optional `serverIds`. Uses Caddy's
`POST /load/config?validate_only=1`, so it is read-only.

### `apply_config`

Arguments: `configId`, optional `serverIds`, `confirm`, `dryRun`,
optional `expectedLiveDigest`.

- `dryRun=true` validates against every target and changes nothing.
- `confirm=true` is required for a real apply.
- `expectedLiveDigest` makes the apply fail with `MCP_CONFLICT` if the server
  changed since you last read it. It requires exactly one `serverId`.
- The backend reads the live config **before** writing. If it cannot, it refuses
  the apply. If Caddy rejects the new config, the backend re-posts the snapshot
  and reports `rolledBack: true`; if restoration also fails, it reports
  `rollbackFailed: true` with `rollbackError`.

## The loop

Never hand-write a whole config and never apply blind. Follow this order:

1. **Discover** — `list_servers`, then `list_configs` for the target.
2. **Read** — `read_config` with `configId` (or `serverId` + `save=true` to snapshot
   the live config). Keep the returned `digest`.
3. **Patch** — `patch_config` with the smallest set of operations that expresses
   the change. Pass `expectedDigest` so a concurrent edit is not clobbered.
4. **Validate** — `validate_config` on the patched config. Fix errors and re-patch.
5. **Dry run** — `apply_config` with `dryRun=true`.
6. **Apply** — `apply_config` with `confirm=true`. If you read the live config in
   step 2, pass `expectedLiveDigest`.
7. **Confirm** — `read_config` with `serverId` and compare the new `digest` with
   the digest returned by `patch_config`.

If any step returns `MCP_CONFLICT`, re-read and re-apply your intent; do not retry
the same patch blindly. If an apply reports `rollbackFailed`, stop changing the
server and report the exact error to the operator — the live state is unknown.

## JSON Pointer cookbook

Caddy JSON is nested; these are the pointers you will actually need for a typical
HTTP server at `/apps/http/servers/<name>`.

| Intent | Operation |
|---|---|
| Add a host match | `{"op":"add","path":"/apps/http/servers/srv0/routes/0/match/0/host/-","value":"new.example.com"}` |
| Add a path match | `{"op":"add","path":"/apps/http/servers/srv0/routes/0/match/0/path","value":["/api/*"]}` |
| Add a route | `{"op":"add","path":"/apps/http/servers/srv0/routes/-","value":{...}}` |
| Replace an upstream | `{"op":"replace","path":"/apps/http/servers/srv0/routes/0/handle/0/upstreams/0/dial","value":"10.0.0.5:8080"}` |
| Add an upstream | `{"op":"add","path":"/apps/http/servers/srv0/routes/0/handle/0/upstreams/-","value":{"dial":"10.0.0.6:8080"}}` |
| Change a static root | `{"op":"replace","path":"/apps/http/servers/srv0/routes/0/handle/0/root","value":"/srv/www"}` |
| Enable directory browsing | `{"op":"add","path":"/apps/http/servers/srv0/routes/0/handle/0/browse","value":true}` |
| Add a redirect | `{"op":"add","path":"/apps/http/servers/srv0/routes/-","value":{"match":[{"path":["/old/*"]}],"handle":[{"handler":"redir","to":"/new{uri}","status_code":301}]}}` |
| Add a response header | `{"op":"add","path":"/apps/http/servers/srv0/routes/0/handle/0/headers/response/X-Frame-Options","value":["DENY"]}` |
| Remove a route | `{"op":"remove","path":"/apps/http/servers/srv0/routes/2"}` |
| Rename a JSON key | `{"op":"move","from":"/apps/http/servers/srv0/routes/0/handle/0/root","path":"/apps/http/servers/srv0/routes/0/handle/0/file_server/root"}` |
| Assert before changing | `{"op":"test","path":"/apps/http/servers/srv0/listen/0","value":":80"}` |

Pointer rules:

- Must start with `/`; `""` means the whole document.
- `~1` means `/` inside a key, `~0` means `~`.
- Array indexes are `0`-based; `-` appends.
- `add` requires the parent to exist; it does not create intermediate objects.
- `replace` and `remove` require the target to exist (`replace` is not an upsert).

Read the pointer you are about to touch from the `summary` returned by
`read_config` — it annotates routes and handlers with their exact pointers.

## Rules

- **Patch, do not rewrite.** Use `patch_config` for edits. `save_config` is for
  creating a new config or replacing a known-good document wholesale.
- **One intent per patch.** Small patches are easier to review, validate and roll
  back than a single 40-operation rewrite.
- **Validation is not optional.** `apply_config` re-validates, but a failed
  `validate_config` should be fixed before you get there.
- **Respect conflicts.** `MCP_CONFLICT` means someone (or something) changed the
  config after you read it. Re-read; never retry with a stale digest.
- **No secrets in configs.** Do not paste credentials, private keys or tokens
  into Caddy JSON. Use environment variables or the operator's secret store.
- **Report, don't guess.** Include `digest`, `configId`, `serverId`, tool error
  codes and, for failures, the target server name in your summary to the user.
- **Read-only keys stay read-only.** If a write tool returns `MCP_FORBIDDEN`, ask
  the operator for a key with `write`; do not try a different route.

## Common tool errors

| Code | Meaning |
|---|---|
| `MCP_FORBIDDEN` | Key lacks the required `read`/`write` permission |
| `MCP_INVALID_ARGUMENT` | Missing/misshaped argument |
| `MCP_INVALID_CONFIG` | Value is not a JSON object / not valid JSON |
| `MCP_PATCH_INVALID` | Pointer missing, bad op, or the patch result would not parse |
| `MCP_CONFLICT` | `expectedDigest` / `expectedLiveDigest` no longer matches |
| `MCP_CONFIRMATION_REQUIRED` | `apply_config` called without `confirm=true` |
| `MCP_API_ERROR` | The REST API rejected the call (inspect the message) |
| `MCP_BACKEND_UNREACHABLE` | The backend's loopback API was unreachable |
