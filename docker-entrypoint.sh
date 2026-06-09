#!/bin/sh
set -e

# Copy the Docker default config if no config is mounted
if [ ! -f /app/meetings.config.yml ]; then
  cp /app/meetings.config.docker.yml /app/meetings.config.yml
fi

exec node dist/cli/index.js serve
