#!/bin/sh
# Runs every spike experiment in turn; prints a one-line summary per script. Needs xvfb-run and Playwright.
cd "$(dirname "$0")" || exit 1
status=0
node test/unit-lib.js > /tmp/spike-unit.log 2>&1 || status=1
tail -1 /tmp/spike-unit.log
for t in q1-q2-mic-and-call q3-q4-binding q5-teardown security-boundary q7-incoming; do
  xvfb-run -a node test/$t.js > /tmp/spike-$t.log 2>&1 || status=1
  tail -1 /tmp/spike-$t.log
done
exit $status
