#!/bin/sh
# Runs the calling tests in order and prints one summary line each.
# Node-only tests need nothing else. manual-call-turn-longcall.js (about two minutes) is left out of
# the default list; run it by hand. The browser tests need Chromium (Playwright) under a display
# (xvfb-run -a sh test/run-call-tests.sh) and the local demo domain on 8002:
#   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
#     ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
cd "$(dirname "$0")/.." || exit 2
status=0
for t in manual-call-protocol manual-call-ice-validation manual-call-service manual-call-unconfigured manual-call-internet-security manual-call-proxy manual-call-turn-service manual-call-turn-probe manual-call-turn-deploy manual-call-e2e manual-call-contacts manual-call-messaging manual-call-mic manual-call-adversary manual-call-bridge manual-call-isolation manual-call-stun manual-call-turn; do
  out=$(node "test/$t.js" 2>&1)
  code=$?
  echo "$t: $(echo "$out" | grep -E ': [0-9]+ passed, [0-9]+ failed' | tail -1) (exit $code)"
  [ "$code" -ne 0 ] && { echo "$out" | grep -E '^(FAIL|Failed)' | head -20; status=1; }
done
exit $status
