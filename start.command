#!/bin/zsh
cd "$(dirname "$0")"
node server.mjs --dir "$(dirname "$PWD")" --open
