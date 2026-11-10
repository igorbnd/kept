#!/usr/bin/env bash
# End-to-end "Claude can pause a payout, never create one" against the real PayPal sandbox + Claude:
#   A) mug, carrier scan "Delivery attempted — no one available to sign", deadline passes
#      -> Claude flags it buyer_caused, the order is HELD (no refund); the merchant clicks Refund
#      -> refunded through PayPal by the same payout code path.
#   B) mug, carrier scan "Delayed — weather", deadline passes
#      -> Claude says seller_side, refunded automatically, with an `assessment` event in the log.
# Needs the API running (npm run dev:api, or API=http://localhost:PORT). Resets the demo data.
set -euo pipefail
API=${API:-http://localhost:8787}
j() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
scan() { curl -sf -X POST $API/api/demo/carrier/$1 -H 'content-type: application/json' -d "{\"status\":\"$2\",\"description\":\"$3\",\"location\":\"$4\"}" >/dev/null; }
buy() {
  local ord
  ord=$(curl -sf -X POST $API/api/orders -H 'content-type: application/json' -d "{\"product_id\":\"$MUG\",\"test_card\":true}" | j 'o.order_id')
  curl -sf -X POST $API/api/orders/$ord/capture | j '`   status=${o.status} total=$${o.amount_total} capture=${o.paypal_capture_id} tracking=${o.tracking_number}`' >&2
  echo "$ord"
}
past_deadline() { # $1 = order id
  local h
  h=$(curl -sf $API/api/orders/$1 | j 'Math.max(1,Math.ceil((Date.parse(o.order.deadline_at)-Date.now())/3600e3)+1)')
  local t0=$(date +%s)
  curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d "{\"hours\":$h}" >/dev/null
  echo "   clock +${h}h (tick incl. Claude's review took $(( $(date +%s) - t0 ))s)" >&2
}
wait_final() {
  for _ in $(seq 1 40); do
    s=$(curl -sf $API/api/orders/$1 | j 'o.order.status')
    [[ "$s" != "paid" && "$s" != "breached" ]] && { echo "$s"; return; }
    sleep 1
  done
  echo "$s"
}

curl -sf -X POST $API/api/demo/reset >/dev/null
MUG=$(curl -sf $API/api/products | j 'o.find(p=>p.name==="Tidepool Mug").id')

echo "A) Attempted delivery, no one home -> held for the merchant"
A=$(buy)
TA=$(curl -sf $API/api/orders/$A | j 'o.order.tracking_number')
scan "$TA" picked_up "Picked up by carrier" "Portland, ME"
scan "$TA" exception "Delivery attempted — no one available to sign" "Portland, ME"
[[ "$(curl -sf $API/api/orders/$A | j 'o.order.status')" == "paid" ]] || fail "A should still be watching before the deadline"
past_deadline "$A"
SA=$(wait_final "$A")
curl -sf $API/api/orders/$A | j '`   status=${o.order.status} review=${o.order.review?.attribution}/${o.order.review?.confidence} pending=$${o.pending_payout} refund=${o.order.paypal_refund_id}\n   claude: ${o.order.review?.reason}`'
[[ "$SA" == "held" ]] || fail "A status=$SA, expected held"
[[ "$(curl -sf $API/api/orders/$A | j 'o.order.review.attribution')" == "buyer_caused" ]] || fail "A attribution should be buyer_caused"
[[ "$(curl -sf $API/api/orders/$A | j 'o.order.paypal_refund_id')" == "null" ]] || fail "A must not be refunded while held"
curl -sf $API/api/stats | j '`   stats: held=${o.held} budget_used=$${o.budget_used}`'
echo "   merchant clicks Refund"
curl -sf -X POST $API/api/orders/$A/review -H 'content-type: application/json' -d '{"decision":"refund"}' | j '`   status=${o.status} payout=$${o.payout_amount} refund=${o.paypal_refund_id}\n   note: ${o.customer_message}`'
curl -sf $API/api/orders/$A | j 'o.order.status==="refunded" && /^[A-Z0-9]{10,}$/.test(o.order.paypal_refund_id) && o.order.review.decision==="refund"' | grep -q true || fail "A should be refunded with a PayPal refund id after the merchant's decision"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/orders/$A/review -H 'content-type: application/json' -d '{"decision":"decline"}')
[[ "$CODE" == "409" ]] || fail "a second decision should be refused (got $CODE)"

echo "B) Weather delay -> seller-side, refunded automatically"
B=$(buy)
TB=$(curl -sf $API/api/orders/$B | j 'o.order.tracking_number')
scan "$TB" picked_up "Picked up by carrier" "Portland, ME"
scan "$TB" delayed "Delayed — weather" "Worcester, MA"
past_deadline "$B"
SB=$(wait_final "$B")
curl -sf $API/api/orders/$B | j '`   status=${o.order.status} review=${o.order.review?.attribution}/${o.order.review?.confidence} payout=$${o.order.payout_amount} refund=${o.order.paypal_refund_id}\n   claude: ${o.order.review?.reason}`'
[[ "$SB" == "refunded" ]] || fail "B status=$SB, expected refunded"
curl -sf $API/api/orders/$B | j 'o.agent_events.some(e=>e.kind==="assessment"&&e.data&&e.data.attribution==="seller_side") && /^[A-Z0-9]{10,}$/.test(o.order.paypal_refund_id)' | grep -q true || fail "B needs a seller_side assessment event and a refund id"

echo "Agent log (A then B)"
for o in $A $B; do curl -sf $API/api/orders/$o | j 'o.agent_events.map(e=>`   [${e.kind}] ${e.message}`).join("\n")'; echo; done
curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d '{"reset":true}' >/dev/null
echo "PASS"
