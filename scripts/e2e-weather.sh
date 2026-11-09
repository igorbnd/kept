#!/usr/bin/env bash
# End-to-end weather promise against the real PayPal sandbox + Claude:
#   A) buy the Sunset Kayak Tour for today (server time), it rains 4 mm in the tour window
#      -> the agent refunds 50% through PayPal.
#   B) buy it for tomorrow, 0 mm of rain -> the promise is marked kept, no refund.
# Needs the API running (npm run dev:api, or API=http://localhost:PORT). Resets the demo data.
set -euo pipefail
API=${API:-http://localhost:8787}
LOC='{"name":"Portland, ME","lat":43.6591,"lon":-70.2568}'
j() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# YYYY-MM-DD in the shop timezone for the server's (simulated) now, plus N days.
day() { curl -sf $API/api/config | j "new Intl.DateTimeFormat('en-CA',{timeZone:o.merchant.timezone}).format(new Date(Date.parse(o.now)+$1*864e5))"; }
# Hours to move the clock so server time passes 20:00 (end of the 4-8 pm window) on a date, + 1h.
hours_past_window() { curl -sf $API/api/config | j "(()=>{const [y,m,d]='$1'.split('-').map(Number);const guess=Date.UTC(y,m-1,d,20);const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:o.merchant.timezone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}).formatToParts(new Date(guess)).map(x=>[x.type,x.value]));const off=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-guess;const end=guess-off;return Math.max(0,Math.ceil((end-Date.parse(o.now))/36e5)+1)})()"; }

buy() { # $1 = event date -> order id
  local ord
  ord=$(curl -sf -X POST $API/api/orders -H 'content-type: application/json' \
    -d "{\"product_id\":\"$TOUR\",\"event_date\":\"$1\",\"event_location\":$LOC,\"test_card\":true}" | j 'o.order_id')
  curl -sf -X POST $API/api/orders/$ord/capture | j '`   status=${o.status} total=$${o.amount_total} capture=${o.paypal_capture_id} date=${o.event_date} @ ${o.event_location.name}`' >&2
  echo "$ord"
}
weather() { curl -sf -X POST $API/api/demo/weather -H 'content-type: application/json' -d "{\"date\":\"$1\",\"location\":\"Portland, ME\",\"precipitation_mm\":$2}" >/dev/null; }
advance() { curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d "{\"hours\":$1}" >/dev/null; }
wait_final() { # $1 = order id -> prints status once it leaves "paid"/"breached"
  for _ in $(seq 1 40); do
    s=$(curl -sf $API/api/orders/$1 | j 'o.order.status')
    [[ "$s" != "paid" && "$s" != "breached" ]] && { echo "$s"; return; }
    sleep 1
  done
  echo "$s"
}

curl -sf -X POST $API/api/demo/reset >/dev/null
TOUR=$(curl -sf $API/api/products | j 'o.find(p=>p.name==="Sunset Kayak Tour").id')

echo "A) Rain path"
D1=$(day 0)
echo "   tour date $D1 (server time); simulated rain 4 mm in Portland, ME"
weather "$D1" 4
A=$(buy "$D1")
[[ "$(curl -sf $API/api/orders/$A | j 'o.order.status')" == "paid" ]] || fail "order A should be watching before the tour ends"
H=$(hours_past_window "$D1"); echo "   clock +${H}h (past 8 pm on $D1)"
advance "$H"
SA=$(wait_final "$A")
curl -sf $API/api/orders/$A | j '`   status=${o.order.status} payout=$${o.order.payout_amount} of $${o.order.amount_total} refund=${o.order.paypal_refund_id}\n   note: ${o.order.customer_message}`'
[[ "$SA" == "refunded" ]] || fail "order A status=$SA, expected refunded"
curl -sf $API/api/orders/$A | j 'o.order.payout_amount===Math.round(o.order.amount_total*50)/100 && /^[A-Z0-9]{10,}$/.test(o.order.paypal_refund_id)' | grep -q true || fail "order A payout/refund id wrong"

echo "B) Dry path"
D2=$(day 1)
echo "   tour date $D2; simulated rain 0 mm"
weather "$D2" 0
B=$(buy "$D2")
H=$(hours_past_window "$D2"); echo "   clock +${H}h (past 8 pm on $D2)"
advance "$H"
SB=$(wait_final "$B")
curl -sf $API/api/orders/$B | j '`   status=${o.order.status} payout=${o.order.payout_amount} refund=${o.order.paypal_refund_id}`'
[[ "$SB" == "kept" ]] || fail "order B status=$SB, expected kept"

echo "Agent log (A then B)"
for o in $A $B; do curl -sf $API/api/orders/$o | j 'o.agent_events.map(e=>`   [${e.kind}] ${e.message}`).join("\n")'; done
curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d '{"reset":true}' >/dev/null
echo "PASS"
