/**
 * Compact, pointer-annotated view of a Caddy JSON config.
 *
 * The agent surface exists because Caddy configs get long. Returning the whole
 * document forces a model to re-emit it; a summary plus JSON Pointers lets the
 * model patch precisely what it means to change.
 */

const MAX_ROUTES = 100;
const MAX_SERVERS = 100;
const MAX_HANDLERS = 100;
const MAX_DEPTH = 4;

function escapePointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function matchSummary(match) {
  if (!match || typeof match !== 'object') return {};
  const out = {};
  if (Array.isArray(match.host) && match.host.length) out.hosts = match.host;
  if (Array.isArray(match.path) && match.path.length) out.paths = match.path;
  if (Array.isArray(match.method) && match.method.length) out.methods = match.method;
  if (Array.isArray(match.protocol)) out.protocols = match.protocol;
  if (match.header) out.headers = match.header;
  if (!Object.keys(out).length) out.any = true;
  return out;
}

function handlerSummary(handler, pointer, depth = 0) {
  if (!handler || typeof handler !== 'object') return { type: 'unknown' };
  const type = handler.handler || 'unknown';

  switch (type) {
    case 'reverse_proxy': {
      const upstreams = (Array.isArray(handler.upstreams) ? handler.upstreams : [])
        .map((u) => u && (u.dial || u.address))
        .filter(Boolean);
      return { type, pointer, upstreams };
    }
    case 'file_server':
      return { type, pointer, root: handler.root || '/', browse: !!handler.browse };
    case 'redir':
      return { type, pointer, to: handler.to, status: handler.status_code };
    case 'respond':
      return { type, pointer, status: handler.status_code, body: typeof handler.body === 'string' ? handler.body.slice(0, 200) : undefined };
    case 'headers':
      return { type, pointer, keys: Object.keys(handler).filter((k) => !['handler'].includes(k)) };
    case 'encode':
      return { type, pointer, encodings: handler.encodings };
    case 'subroute':
      return {
        type,
        pointer,
        routes: Array.isArray(handler.routes)
          ? handler.routes.slice(0, MAX_ROUTES).map((route, index) => routeSummary(route, `${pointer}/routes/${index}`, depth + 1))
          : [],
        routesTruncated: Array.isArray(handler.routes) && handler.routes.length > MAX_ROUTES,
      };
    default:
      return { type, pointer };
  }
}

function routeSummary(route, pointer, depth = 0) {
  if (!route || typeof route !== 'object' || depth > MAX_DEPTH) return { pointer };

  const handlerList = Array.isArray(route.handle)
    ? route.handle
    : Array.isArray(route.handle_path)
      ? route.handle_path
      : [];
  const handlers = handlerList
    .slice(0, MAX_HANDLERS)
    .map((handler, index) => handlerSummary(handler, `${pointer}/${Array.isArray(route.handle) ? 'handle' : 'handle_path'}/${index}`, depth));

  return {
    pointer,
    match: matchSummary(route.match && route.match[0]),
    terminal: !!route.terminal,
    handlers,
    handlerCount: handlerList.length,
    handlersTruncated: handlerList.length > MAX_HANDLERS,
  };
}

function summarizeServer(server, pointer) {
  const routes = Array.isArray(server.routes) ? server.routes : [];
  return {
    pointer,
    listen: server.listen || [],
    routeCount: routes.length,
    routesTruncated: routes.length > MAX_ROUTES,
    routes: routes.slice(0, MAX_ROUTES).map((route, index) => routeSummary(route, `${pointer}/routes/${index}`)),
  };
}

function summarizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }

  const summary = {
    topLevelKeys: Object.keys(config),
    apps: config.apps && typeof config.apps === 'object' ? Object.keys(config.apps) : [],
  };

  const httpServers = config.apps && config.apps.http && config.apps.http.servers;
  if (httpServers && typeof httpServers === 'object' && !Array.isArray(httpServers)) {
    const serverEntries = Object.entries(httpServers);
    summary.http = {
      serverNames: Object.keys(httpServers).slice(0, MAX_SERVERS),
      serverCount: serverEntries.length,
      serversTruncated: serverEntries.length > MAX_SERVERS,
      servers: serverEntries.slice(0, MAX_SERVERS).map(([name, server]) =>
          summarizeServer(server || {}, `/apps/http/servers/${escapePointerSegment(name)}`)),
    };
  }

  if (config.apps && config.apps.tls) {
    const tls = config.apps.tls;
    summary.tls = {
      automationPolicies: Array.isArray(tls.automation)
        ? tls.automation.map((policy, index) => ({
          pointer: `/apps/tls/automation/${index}`,
          subjects: policy && policy.subjects,
          issuers: policy && Array.isArray(policy.issuers)
            ? policy.issuers.map((issuer) => issuer && issuer.module).filter(Boolean)
            : [],
        }))
        : [],
      loadedCertificates: tls.certificates && Array.isArray(tls.certificates.load_files)
        ? tls.certificates.load_files
        : [],
    };
  }

  return summary;
}

module.exports = { summarizeConfig };
