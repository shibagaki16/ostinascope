#!/bin/sh
# Assemble the published site in _site/: only what the app needs
# (index.html, sw.js, src/, poster/), stamped with the commit it was built
# from — src/app/build.js and version.json, which the app shows and checks
# to offer an update when a newer one is out.
#
# Cloudflare runs this on every push to main (wrangler.jsonc, after the
# tests); `sh scripts/build-site.sh` makes the same _site/ locally.
set -eu
cd "$(dirname "$0")/.."

sha="${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
commit=$(printf '%s' "$sha" | cut -c1-7)
time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

rm -rf _site
mkdir -p _site
cp -R index.html sw.js src poster _site/
rm -f _site/poster/*.bak
find _site -name .DS_Store -delete
printf "// written by scripts/build-site.sh\nexport const BUILD = { commit: '%s', time: '%s' };\n" "$commit" "$time" > _site/src/app/build.js
printf '{"commit":"%s","time":"%s"}\n' "$commit" "$time" > _site/version.json
find _site -type f | sort
