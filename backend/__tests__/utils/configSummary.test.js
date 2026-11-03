const { summarizeConfig } = require('../../utils/configSummary');

describe('configSummary', () => {
  test('returns compact pointer-annotated server, route and handler summaries', () => {
    const summary = summarizeConfig({
      apps: {
        http: {
          servers: {
            'prod/a~b': {
              listen: [':443'],
              routes: [{
                match: [{ host: ['example.com'], path: ['/api/*'] }],
                handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:9000' }] }],
              }],
            },
          },
        },
      },
    });

    expect(summary.http.servers[0].pointer).toBe('/apps/http/servers/prod~1a~0b');
    expect(summary.http.servers[0].routes[0].pointer).toBe('/apps/http/servers/prod~1a~0b/routes/0');
    expect(summary.http.servers[0].routes[0].match).toEqual({
      hosts: ['example.com'],
      paths: ['/api/*'],
    });
    expect(summary.http.servers[0].routes[0].handlers[0]).toEqual({
      type: 'reverse_proxy',
      pointer: '/apps/http/servers/prod~1a~0b/routes/0/handle/0',
      upstreams: ['127.0.0.1:9000'],
    });
  });

  test('bounds large server, route and handler collections', () => {
    const routes = Array.from({ length: 105 }, () => ({ handle: Array.from({ length: 105 }, () => ({ handler: 'file_server' })) }));
    const servers = Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`srv${i}`, { routes }]));
    const summary = summarizeConfig({ apps: { http: { servers } } });

    expect(summary.http.serverCount).toBe(105);
    expect(summary.http.servers).toHaveLength(100);
    expect(summary.http.serversTruncated).toBe(true);
    expect(summary.http.servers[0].routeCount).toBe(105);
    expect(summary.http.servers[0].routes).toHaveLength(100);
    expect(summary.http.servers[0].routesTruncated).toBe(true);
    expect(summary.http.servers[0].routes[0].handlerCount).toBe(105);
    expect(summary.http.servers[0].routes[0].handlers).toHaveLength(100);
    expect(summary.http.servers[0].routes[0].handlersTruncated).toBe(true);
  });

  test('stops summarizing deeply nested subroutes', () => {
    let handler = { handler: 'respond', body: 'done' };
    for (let i = 0; i < 20; i += 1) {
      handler = { handler: 'subroute', routes: [{ handle: [handler] }] };
    }

    const summary = summarizeConfig({
      apps: { http: { servers: { srv0: { routes: [{ handle: [handler] }] } } } },
    });

    expect(summary.http.servers[0].routes[0].handlers[0].type).toBe('subroute');
  });

  test('requires a JSON object', () => {
    expect(() => summarizeConfig(null)).toThrow(/JSON object/);
    expect(() => summarizeConfig([])).toThrow(/JSON object/);
  });
});
