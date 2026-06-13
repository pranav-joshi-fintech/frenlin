#!/usr/bin/env bash
# Start the Vegeta ASMR backend with the correct virtualenv.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

.venv/bin/pip install -q -r requirements.txt

echo "Starting backend on http://127.0.0.1:5001"
.venv/bin/python app.py
