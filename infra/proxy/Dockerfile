# iPredict — Caddy reverse proxy / TLS termination.
#
# The official Caddy image already ships everything the proxy needs (the
# binary plus its CA store); this image just pins the Caddyfile so the
# proxy is fully defined in infra/proxy/.
FROM caddy:2.11.2-alpine@sha256:791838d21b47372e9d290c0aa48aa7d97b09c5d01306eb55355034c562e8412a

COPY Caddyfile /etc/caddy/Caddyfile
