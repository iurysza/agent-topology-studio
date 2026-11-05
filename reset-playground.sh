#!/bin/sh
# Restore playground/ to the pristine fixture copy.
set -e
cd "$(dirname "$0")"
rm -rf playground
cp -R fixtures/playground playground
echo "playground reset"
