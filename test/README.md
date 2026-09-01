# test/
Edge Caddy for isolated security testing. Use `docker compose -f docker-compose.build.yml -f docker-compose.test.yml up --build -d` then hit http://localhost:18080.
Caddyfile.edge proxies to frontend:80. Network caddy-test-network is external, created by development/spin-caddy-servers.sh.
