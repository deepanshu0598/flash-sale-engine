#!/usr/bin/env bash
# Raises the OS-level connection limits that block a 10K-VU k6 run.
# Run this on the SERVER VM (the one running docker compose), not the k6 machine.
#
# Why these specific limits: Windows caps the TCP listen backlog at ~200
# pending connections — that's the wall this project's local load testing
# hit (see README.md "10K VUs — requires Linux + tuned kernel"). Linux's
# default is higher but still not high enough for 10K concurrent connection
# attempts in a short ramp window. These values are generous enough that the
# kernel is never the bottleneck; the application/nginx config becomes the
# real limit instead, which is what you actually want to be measuring.
set -euo pipefail

echo "Current values:"
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog
ulimit -n

echo ""
echo "Applying..."
sudo sysctl -w net.core.somaxconn=65535
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
ulimit -n 65535

echo ""
echo "Applied for this session. To persist across reboots, append to /etc/sysctl.conf:"
cat <<'EOF'
  net.core.somaxconn=65535
  net.ipv4.tcp_max_syn_backlog=65535
  net.ipv4.ip_local_port_range=1024 65535
  net.ipv4.tcp_tw_reuse=1
EOF

echo ""
echo "Also raise the systemd/docker file-descriptor limit if running via systemd:"
echo "  sudo systemctl edit docker  ->  add [Service]\\nLimitNOFILE=65535"
echo "  sudo systemctl restart docker"
