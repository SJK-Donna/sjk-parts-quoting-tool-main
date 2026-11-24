#!/bin/sh
# Build for hosting: run the pricing tests, then copy only the site files into _site/.
# The site is the interface from the Sales Tool Guide / Admin Console Guide: index.html + backend.js + data.
# (full-tool.html, css/ and js/ are the earlier Zoho/PDF version, kept in the repo but not published.)
# Cloudflare Pages settings → Build command: sh scripts/build-site.sh   Output directory: _site
set -e
node tests/pricing.test.js
rm -rf _site
mkdir _site
cp -r index.html backend.js data _site/
echo "Built _site/"
