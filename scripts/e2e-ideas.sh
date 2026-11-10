#!/usr/bin/env bash
# End-to-end "Promise ideas" against the real PayPal sandbox + Claude + Open-Meteo:
#   the Kept agent suggests 3 promises for the mug; we approve the first fixed-date one
#   ("…before Thanksgiving…"), buy with the sandbox test card, let the date pass undelivered,
#   and check PayPal refunds the computed amount. Then jump past the order-by cutoff and check
#   the promise is no longer offered. Needs the API running (API=http://localhost:PORT). Resets the demo.
set -euo pipefail
API=${API:-http://localhost:8787}
j() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

curl -sf -X POST $API/api/demo/reset >/dev/null
MUG=$(curl -sf $API/api/products | j 'o.find(p=>p.name==="Tidepool Mug").id')
echo "1) Ask the Kept agent for promise ideas for the mug"
IDEAS=$(curl -sf -X POST $API/api/promises/suggest -H 'content-type: application/json' -d "{\"product_id\":\"$MUG\"}")
echo "$IDEAS" | j 'o.ideas.map(i=>`   • ${i.title} [${i.factors}] ${i.promise?.compiled.badge ?? i.error}\n     ${i.cost ? `≈ $${i.cost.expected}/order: ${i.cost.basis}` : ""}`).join("\n")'
PRM=$(echo "$IDEAS" | j 'o.ideas.find(i=>i.promise?.compiled.rule?.condition.deadline?.kind==="by_date")?.promise.id ?? ""')
[ -n "$PRM" ] || fail "no fixed-date idea this time (re-run; ideas vary)"
echo "$IDEAS" | j "(()=>{const r=o.ideas.find(i=>i.promise?.id==='$PRM').promise.compiled.rule;return '   chosen rule: '+JSON.stringify(r)})()"
curl -sf -X POST $API/api/promises/$PRM/activate >/dev/null

echo "2) Buy it with the sandbox test card"
ORD=$(curl -sf -X POST $API/api/orders -H 'content-type: application/json' -d "{\"product_id\":\"$MUG\",\"test_card\":true}" | j 'o.order_id')
curl -sf -X POST $API/api/orders/$ORD/capture | j '`   status=${o.status} total=$${o.amount_total} deadline=${o.deadline_at}`'
DL=$(curl -sf $API/api/orders/$ORD | j 'o.order.deadline_at')
DATE=$(curl -sf $API/api/orders/$ORD | j 'o.order.promise_snapshot.rule.condition.deadline.date')
node -e "const d=new Date('$DL');const s=d.toLocaleString('en-CA',{timeZone:'America/New_York',hour12:false});if(!s.startsWith('$DATE')||!s.includes('23:59:59'))process.exit(1)" || fail "deadline $DL isn't 11:59:59 pm on $DATE shop time"
echo "   deadline is 11:59:59 pm on $DATE, shop time"
TRK=$(curl -sf $API/api/orders/$ORD | j 'o.order.tracking_number')
curl -sf -X POST $API/api/demo/carrier/$TRK -H 'content-type: application/json' -d '{"status":"picked_up","description":"Picked up","location":"Portland, ME"}' >/dev/null
curl -sf -X POST $API/api/demo/carrier/$TRK -H 'content-type: application/json' -d '{"status":"delayed","description":"Delayed — holiday volume","location":"Hartford, CT"}' >/dev/null

echo "3) Jump past the date, undelivered"
HOURS=$(node -e "console.log(Math.ceil((Date.parse('$DL')-Date.parse('$(curl -sf $API/api/config | j 'o.now')'))/3600e3)+1)")
curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d "{\"hours\":$HOURS}" >/dev/null
for i in $(seq 1 30); do
  ST=$(curl -sf $API/api/orders/$ORD | j 'o.order.status'); [ "$ST" = refunded ] || [ "$ST" = held ] || [ "$ST" = failed ] && break; sleep 2
done
curl -sf $API/api/orders/$ORD | j '`   status=${o.order.status} payout=$${o.order.payout_amount} refund=${o.order.paypal_refund_id}\n   note: ${o.order.customer_message}`'
[ "$ST" = refunded ] || fail "expected refunded, got $ST"
EXPECTED=$(curl -sf $API/api/orders/$ORD | j '(()=>{const p=o.order.promise_snapshot.rule.payout,t=o.order.amount_total;return (p.kind==="percent_of_total"?Math.round(t*p.percent)/100:p.kind==="fixed"?Math.min(p.amount,t):o.order.amount_shipping).toFixed(2)})()')
GOT=$(curl -sf $API/api/orders/$ORD | j 'o.order.payout_amount.toFixed(2)')
[ "$EXPECTED" = "$GOT" ] || fail "payout $GOT != rule's $EXPECTED"

echo "4) Past the order-by cutoff, the promise is closed"
OPEN=$(curl -sf $API/api/products | j 'o.find(p=>p.name==="Tidepool Mug").promise_open')
[ "$OPEN" = false ] || fail "promise still open after the cutoff"
ORD2=$(curl -sf -X POST $API/api/orders -H 'content-type: application/json' -d "{\"product_id\":\"$MUG\",\"test_card\":true}" | j 'o.order_id')
SNAP=$(curl -sf $API/api/orders/$ORD2 | j 'String(o.order.promise_snapshot)')
[ "$SNAP" = null ] || fail "late order still carries the promise"
echo "   promise_open=false; a new order carries no promise"
curl -sf -X POST $API/api/demo/clock -H 'content-type: application/json' -d '{"reset":true}' >/dev/null || true
echo PASS
