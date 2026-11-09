#!/usr/bin/env bash
# End-to-end against the real PayPal sandbox + Claude: buy a mug, let Friday pass with the
# parcel stuck, and watch the agent refund shipping. Needs the API running (npm run dev:api).
set -euo pipefail
API=${API:-http://localhost:8787}
j() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }

curl -sf -X POST $API/api/demo/reset >/dev/null
MUG=$(curl -sf $API/api/products | j 'o.find(p=>p.name==="Tidepool Mug").id')
echo "1) Buy Tidepool Mug with sandbox test card"
ORD=$(curl -sf -X POST $API/api/orders -H 'content-type: application/json' -d "{\"product_id\":\"$MUG\",\"test_card\":true}" | j 'o.order_id')
curl -sf -X POST $API/api/orders/$ORD/capture | j '`   status=${o.status} total=$${o.amount_total} capture=${o.paypal_capture_id} tracking=${o.tracking_number} deadline=${o.deadline_at}`'
TRK=$(curl -sf $API/api/orders/$ORD | j 'o.order.tracking_number')
echo "2) Parcel picked up, then delayed"
curl -sf -X POST $API/api/demo/carrier/$TRK -H 'content-type: application/json' -d '{"status":"picked_up","description":"Picked up","location":"Portland, ME"}' >/dev/null
curl -sf -X POST $API/api/demo/carrier/$TRK -H 'content-type: application/json' -d '{"status":"delayed","description":"Delayed — weather","location":"Worcester, MA"}' >/dev/null
curl -sf $API/api/orders/$ORD | j '`   status=${o.order.status}`'
echo "3) Jump the clock past the deadline"
HOURS=$(curl -sf $API/api/orders/$ORD | j 'Math.ceil((new Date(o.order.deadline_at)-Date.now())/3600e3)+1')
curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d "{\"hours\":$HOURS}" >/dev/null
sleep 2
curl -sf $API/api/orders/$ORD | j '`   status=${o.order.status} payout=$${o.order.payout_amount} refund=${o.order.paypal_refund_id}\n   note: ${o.order.customer_message}`'
echo "4) Agent log"
curl -sf $API/api/orders/$ORD | j 'o.agent_events.map(e=>`   [${e.kind}] ${e.message}`).join("\n")'
