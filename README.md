# Kept: promises that keep themselves

A merchant writes a guarantee in plain English, like *"Arrives by Friday or shipping's on us"* or *"Rain on tour day = 50% back."*
**Claude** turns it into a rule that can be checked. An **agent** watches real-world evidence (carrier tracking, live Open-Meteo weather). When a promise breaks, **PayPal refunds the buyer automatically**, before they ask, with a note explaining why.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/), 2026.

![Refund: promise broken, refunded automatically](docs/screenshots/order.png)

## The problem
Guarantees are the cheapest trust signal a small shop has, and the hardest to keep. A two-person studio can write "arrives by Friday or shipping's on us", but then someone has to check every parcel, notice every miss, and process every refund. In practice the buyer has to notice, complain and argue. Most never do, so the promise quietly turns into marketing.


## How Kept differs from what exists
Pieces of this already exist. Weather guarantees that pay out automatically ([Sensible Weather](https://www.sensibleweather.com/), [WeatherPromise](https://purchase.weatherpromise.com/us/en/)) are fixed products sold by an insurer. Merchant-run shipping guarantees ([ShipAid](https://www.shipaid.com/)) still rely on the buyer filing a claim. AI support agents (for example [Yuma](https://yuma.ai/ai-support-agent)) can resolve late orders proactively, but a model decides each case. LLM "intelligent contracts" ([GenLayer](https://docs.genlayer.com/understand-genlayer-protocol/typical-use-cases)) also have a model judge each claim.

Kept makes a different split:
- **The AI compiles the promise; code keeps it.** Claude turns the merchant's words into a typed rule *once*. The merchant reviews and approves it, and from then on no model decides money. The outcome is deterministic, auditable, capped and testable.
- **The promise is a contract the buyer can see.** The exact rule is shown at checkout and frozen into the order. It isn't an internal policy hidden behind a support bot.
- **Promises that can't be checked are refused.** "You'll love it or your money back" gets a rewrite that can be checked, not a fake guarantee.
- **One engine for any promise, in the merchant's own words.** Delivery and weather today, on the same rule language, with no fixed product catalog.
- **Native to the payment.** Refunds go against the PayPal capture, tracking is attached to the same capture, and a monthly budget caps total exposure.

## How it works

| | |
|---|---|
| **1. Write** | In the **Promise Studio**, the merchant types a promise. Claude (`claude-opus-5-5`, structured output validated by Zod) compiles it into a small typed rule language: condition, deadline or weather threshold, and payout. It lists every assumption it made and every question the merchant should settle. Subjective promises ("you'll love it") are refused, and Claude suggests a checkable rewrite. |
| **2. Approve** | The merchant approves the rule. It goes live as a badge on the product. |
| **3. Buy** | The buyer pays with **PayPal Checkout** (Orders v2). The promise is frozen into the order, and the shipment's tracking number is attached to the PayPal capture (Orders v2 tracking). |
| **4. Watch** | A deterministic agent loop checks the evidence: carrier scans, or real hourly weather from Open-Meteo for the tour window. Every observation is written to an audit trail. |
| **5. Keep** | When a promise breaks, code computes the payout and **PayPal Payments v2** issues a partial refund (idempotent, with `note_to_payer`). Claude writes the buyer a short note citing the evidence. |
| **6. Account** | The merchant's **AG Grid ledger** shows every order, its latest evidence, the decision, the payout and the PayPal refund id, with live updates and a budget meter. |

| Promise Studio | Ledger (AG Grid) |
|---|---|
| ![Studio](docs/screenshots/studio-reject.png) | ![Ledger](docs/screenshots/ledger.png) |

## Trust by design
- **The AI writes the rule; code enforces it.** Claude never decides an amount. `server/watcher.ts` evaluates the rule and computes the payout.
- **Payouts are capped** at the captured amount and at the merchant's monthly guarantee budget. Over budget, the agent stops and asks a human.
- **A human approves every rule** before it goes live.
- **The buyer gets the promise they saw.** It's frozen at purchase.
- **Refunds are idempotent**, keyed on the order id, so a retry can never pay twice.
- **The model is never on the critical path for money.** If Claude is unavailable, the refund still goes out with a template note.

## Try it (judges)

**Hosted demo:** _URL added after deploy_

1. **Shop:** buy the *Tidepool Mug*. Either:
   - Click **"Judges: skip login — pay with PayPal sandbox test card"** (no account needed), or
   - Click the PayPal button and log in with the sandbox buyer below.
2. You land on the order page: *"Watching your promise."*
3. Open **Demo controls** (top right):
   - Under the order, click **Delayed (weather)**.
   - Then click **Jump to Saturday 00:01**.
4. Within seconds the order page flips to **"$6.40 refunded to your PayPal"**, with Claude's note and the real PayPal sandbox refund id.
5. Open **Ledger** to see it in AG Grid, plus the agent's activity log.
6. Open **Promise Studio** and write your own promise. Try *"You'll love it or your money back"* to see a rejection.

The kayak tour checks **real weather** for the date and city you pick. Demo controls can also simulate rain; simulated evidence is clearly labelled as such.

**PayPal sandbox buyer** (sandbox only, no real money):
- Email: `sb-dt47k053823678@personal.example.com`
- Password: `mZF6&A9M`

## Run locally
Requirements: Node 22.13+ (uses the built-in `node:sqlite`), a PayPal sandbox app, and an Anthropic API key.

```bash
git clone https://github.com/igorbnd/kept && cd kept
npm install
cp .env.example .env     # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, ANTHROPIC_API_KEY
npm run dev              # API on :8787, web on http://localhost:5173
```
Production: `npm run build && npm start` serves everything on `:8787`. To deploy on Render, use the included `render.yaml` blueprint.

End-to-end check against the real sandbox, with the API running:
```bash
./scripts/e2e.sh           # buy → parcel delayed → Friday passes → PayPal refund → Claude note
./scripts/e2e-weather.sh   # kayak tour: 4 mm rain → 50% PayPal refund; 0 mm → promise kept
```
(Both reset the demo data. Point them elsewhere with `API=http://localhost:PORT`.)

Public deploys are rate-limited per IP (e.g. 10 promise compiles, 30 orders, 3 demo resets per 10 minutes) and keep only the newest 200 orders and 1,000 agent events. Requests from localhost with no proxy headers are exempt; set `RATE_LIMIT=off` to disable entirely. On an empty ledger, **Demo controls → Load sample history** buys 4 real sandbox orders with the test card (their carrier scans and one rainy day are simulated, and labelled as such).

## Architecture
```
web/ (React + Vite + AG Grid)  ──►  server/index.ts (Hono)
                                        ├─ ai/compiler.ts   Claude: promise → typed rule (structured output)
                                        ├─ ai/narrator.ts   Claude: buyer refund note (≤255 chars, with fallback)
                                        ├─ paypal.ts        Orders v2 create/capture/track · Payments v2 refund
                                        ├─ watcher.ts       agent loop: evidence → verdict → capped payout
                                        ├─ sources/         Open-Meteo weather (real) · KeptPost carrier (simulated)
                                        └─ db.ts            Node built-in SQLite + simulated clock for demos
```

## AI tools used
- **Claude `claude-opus-5-5`** (Anthropic API) compiles promises into rules and writes buyer refund notes, at runtime.
- **Claude Code** helped build this project.

## Built during the submission period
Everything in this repo was written from scratch between Nov 9 and Nov 12, 2026.

## License
[MIT](LICENSE)
