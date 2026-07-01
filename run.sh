#!/usr/bin/env bash
# ===========================================================================
#  Bixi (BixiSVN) - app-mode launcher (macOS / Linux).
#
#  Serves the app with PHP's built-in web server in your session, so external
#  tools (diff viewer, "Open", "Reveal") launch visibly. No Apache needed.
#
#    chmod +x run.sh   # first time only
#    ./run.sh          # then open the URL it prints (it also tries to open it)
#
#  Press Ctrl+C to stop. Override the port with: PORT=9000 ./run.sh
# ===========================================================================
set -e

PORT="${PORT:-8787}"
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://127.0.0.1:${PORT}/"

if ! command -v php >/dev/null 2>&1; then
    echo "PHP was not found on your PATH. Install PHP 8.2+ and try again."
    exit 1
fi

echo "Starting Bixi at ${URL}"
echo "(Press Ctrl+C to stop.)"

# Open the browser once the server is up (best-effort).
(
    sleep 1
    if command -v open >/dev/null 2>&1; then open "${URL}"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "${URL}"
    fi
) >/dev/null 2>&1 &

exec php -S "127.0.0.1:${PORT}" -t "${DIR}"
