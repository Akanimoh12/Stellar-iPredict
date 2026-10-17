# iPredict — Caddy reverse proxy / TLS termination.
#
# The official Caddy image already ships everything the proxy needs (the
# binary plus its CA store); this image just pins the Caddyfile so the
# proxy is fully defined in infra/proxy/.
FROM caddy:2.11.2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
