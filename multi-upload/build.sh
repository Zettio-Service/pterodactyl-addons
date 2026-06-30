#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -f multiupload.blueprint
zip -r -X multiupload.blueprint conf.yml wrapper.blade.php index.blade.php assets public README.md -x '*.DS_Store' >/dev/null
echo "Built multiupload.blueprint"
