#!/bin/sh
if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi
cat "$(dirname "$0")/dump-graph-output.pinned.json"
