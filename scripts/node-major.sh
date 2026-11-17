#!/usr/bin/env bash
# Prints the Node major that the Dockerfile's base stage names, for CI jobs
# that install Node before pnpm exists. It fails unless exactly one line
# matches, so setup-node never falls back to the runner's own Node.
# scripts/node-runtime.mts#readNodeRuntime holds the line to the same pattern.
set -euo pipefail

pattern='^FROM node:([0-9]+)-alpine(@sha256:[0-9a-f]{64})? AS base$'
dockerfile="$(dirname "$0")/../Dockerfile"

count=$(grep -cE "$pattern" "$dockerfile" || true)
if [ "$count" != 1 ]; then
  echo "$dockerfile: want one line matching $pattern, found ${count:-none}" >&2
  exit 1
fi
sed -nE "s/$pattern/\1/p" "$dockerfile"
