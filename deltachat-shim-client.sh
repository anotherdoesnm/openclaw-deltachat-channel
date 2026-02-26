#!/bin/bash
# Simple helper to call the runner shim over unix socket
SOCKET=/tmp/deltachat.sock
if [ ! -S "$SOCKET" ]; then echo "Socket not found: $SOCKET"; exit 1; fi

function call() {
  local method=$1; shift
  local params=$@
  local payload
  payload=$(jq -n --arg m "$method" --argjson p "[${params}]" '{method:$m, params:$p}')
  # Use socat to send HTTP over unix socket
  socat - UNIX-CONNECT:$SOCKET | sed -n '1,200p'
}

# Example usage (manual):
# echo '{"method":"listChats","params":[]}' | socat - UNIX-CONNECT:/tmp/deltachat.sock
