#!/bin/sh
# Runs before nginx starts (official image /docker-entrypoint.d): use the container's own DNS server
# for per-request resolution of API_UPSTREAM.
set -eu
ns=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
case "$ns" in *:*) ns="[$ns]" ;; esac
echo "resolver ${ns:-127.0.0.11} valid=30s ipv6=off;" > /etc/nginx/conf.d/00-resolver.conf
