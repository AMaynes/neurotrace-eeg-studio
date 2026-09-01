#!/bin/zsh

# Double-click this file in Finder to build and run NeuroTrace on a chosen
# localhost port. Keep the Terminal window open while using the viewer.

set -u

APP_TITLE="NeuroTrace Local Viewer"
DEFAULT_PORT="4173"
PROJECT_DIR="${0:A:h}"
PORT=""

cd "$PROJECT_DIR" || exit 1

show_alert() {
  local alert_text="$1"
  print -u2 -r -- "$alert_text"
  /usr/bin/osascript - "$alert_text" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set alertText to item 1 of argv
  display alert "NeuroTrace Local Viewer" message alertText as warning
end run
APPLESCRIPT
}

fail_launch() {
  show_alert "$1"
  exit 1
}

prompt_for_port() {
  /usr/bin/osascript - "$DEFAULT_PORT" <<'APPLESCRIPT'
on run argv
  set defaultPort to item 1 of argv
  try
    set portDialog to display dialog "Enter the localhost port for NeuroTrace (1024–65535)." default answer defaultPort buttons {"Cancel", "Start"} default button "Start" cancel button "Cancel" with title "Launch NeuroTrace"
    return text returned of portDialog
  on error number -128
    return "__CANCEL__"
  end try
end run
APPLESCRIPT
}

validate_port() {
  local candidate="$1"
  if [[ "$candidate" != <-> ]]; then
    return 1
  fi

  local numeric_port=$((10#$candidate))
  if (( numeric_port < 1024 || numeric_port > 65535 )); then
    return 1
  fi

  PORT="$numeric_port"
  return 0
}

port_is_busy() {
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

if [[ -n "${NEUROTRACE_PORT:-}" ]]; then
  validate_port "$NEUROTRACE_PORT" || fail_launch "NEUROTRACE_PORT must be a number from 1024 through 65535."
  port_is_busy && fail_launch "Port $PORT is already in use."
else
  while true; do
    selected_port="$(prompt_for_port)"
    [[ "$selected_port" == "__CANCEL__" ]] && exit 0

    if ! validate_port "$selected_port"; then
      show_alert "Enter a whole-number port from 1024 through 65535."
      continue
    fi
    if port_is_busy; then
      show_alert "Port $PORT is already in use. Choose another port."
      continue
    fi
    break
  done
fi

command -v node >/dev/null 2>&1 || fail_launch "Node.js 22.13 or newer is required. Install it from nodejs.org, then open this launcher again."
command -v npm >/dev/null 2>&1 || fail_launch "npm is required. Install the current Node.js release, then open this launcher again."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' \
  || fail_launch "NeuroTrace requires Node.js 22.13 or newer."

if [[ ! -d node_modules/vite ]]; then
  print -r -- "Preparing NeuroTrace for its first local launch…"
  npm ci || fail_launch "NeuroTrace could not install its required local components. Check your internet connection and try again."
fi

print -r -- "Building the local viewer…"
npm run build:pages || fail_launch "NeuroTrace could not prepare the local viewer."

LOCAL_URL="http://127.0.0.1:$PORT/"
print
print -r -- "NeuroTrace is starting at $LOCAL_URL"
print -r -- "Keep this window open. Press Control-C here to stop the local viewer."
print

opener_pid=""
if [[ "${NEUROTRACE_NO_OPEN:-0}" != "1" ]]; then
  (
    for _attempt in {1..80}; do
      if /usr/bin/curl --fail --silent --output /dev/null "$LOCAL_URL"; then
        /usr/bin/open "$LOCAL_URL"
        exit 0
      fi
      /bin/sleep .25
    done
  ) &
  opener_pid="$!"
fi

npm run preview:local -- --port "$PORT"
server_status="$?"

if [[ -n "$opener_pid" ]]; then
  kill "$opener_pid" >/dev/null 2>&1 || true
fi

if (( server_status == 130 || server_status == 143 )); then
  print -r -- "NeuroTrace stopped."
  exit 0
fi
if (( server_status != 0 )); then
  fail_launch "The local NeuroTrace server stopped unexpectedly."
fi
