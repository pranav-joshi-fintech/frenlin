#!/usr/bin/env bash
# Start the Frenlin backend with the correct virtualenv.
# Works on Windows (Git Bash: .venv/Scripts) and macOS/Linux (.venv/bin).
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python -m venv .venv 2>/dev/null || python3 -m venv .venv
fi

# Resolve venv python for either layout.
if [[ -f .venv/Scripts/python.exe ]]; then
  VENV_PY=".venv/Scripts/python.exe"
else
  VENV_PY=".venv/bin/python"
fi

"$VENV_PY" -m pip install -q -r requirements.txt

echo "Starting backend on http://127.0.0.1:5001"
"$VENV_PY" app.py
