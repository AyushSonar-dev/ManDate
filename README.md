# Mandate Guard

A spending-authorization layer for AI shopping agents. Every PayPal tool call is checked against a user-defined mandate and recorded in an audit log.

## Status

Stage 9: deterministic guard rules, a fail-closed AI intent check, approval review, sandbox capture, order receipts, a red-team suite with a model-generated held-out set, and a Next.js web console.

## Requirements

- Node.js 20.9+
- Docker (for PostgreSQL)

## Setup

```bash
npm install
cp .env.example .env
npm run db:up
npm run prisma:generate
```

## Development

Run the API and web console in separate terminals:

```bash
npm run dev      # API on http://localhost:3000
npm run dev:web  # web console on http://localhost:3001
```

The API listens on `http://localhost:3000`. Check health:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## Web console

Open `http://localhost:3001`. The web app proxies `/api/*` to `API_BASE_URL` (default `http://localhost:3000`).

- `/mandate` creates and displays the current spending mandate.
- `/run` runs the shopping agent and polls the audit log for live guarded decisions.
- `/approvals` lists pending approvals and resolves them.
- `/orders/[id]` shows an order receipt, decision trail, rules, and approvals.
- `/scorecard` shows the latest persisted red-team run.

The supporting API endpoints are `GET /mandates/:id/decisions`, `GET /scorecard/latest`, and `POST /agent/runs`.

## Shopping agent

Create a mandate through `POST /mandates`, then run the agent:

```bash
npm run agent -- --mandate <id> "buy wireless headphones under 40 dollars"
```

The agent searches the storefront, inspects full product pages, and calls the guarded PayPal `create_order` tool. Every reasoning step, tool call and tool result is logged. A blocked or approval-required order never reaches PayPal.

After the deterministic rules return `ALLOW`, a second intent check compares the user's original request with the proposed cart. Product names and other cart text are passed to the model as untrusted, delimited data. A partial or mismatched intent, malformed JSON, a model error, or a timeout all require approval. A deterministic `BLOCK` is never loosened. Configure the timeout with `INTENT_TIMEOUT_MS` (default 5000).

The mock catalog (`apps/api/data/catalog.json`) is the default and is used by tests and the red-team suite. For the live demo, set `STOREFRONT_PROVIDER=channel3` and `CHANNEL3_API_KEY`. Channel3 responses are cached under `CHANNEL3_CACHE_DIR`; set `CHANNEL3_OFFLINE=true` to replay cached responses without network access or an API key.

## Approvals and receipts

When the guard returns `REQUIRE_APPROVAL`, review the pending approval:

```bash
curl http://localhost:3000/approvals?status=PENDING
```

Approving re-runs the guard before anything is sent to PayPal. If the order is still allowed, the API creates a PayPal sandbox order and returns `202 PENDING_BUYER_APPROVAL` with the approval link. Approve the order in the PayPal sandbox, then call approve again to capture it. Spent budget is only updated after a `COMPLETED` capture.

```bash
curl -X POST http://localhost:3000/approvals/<id>/approve \
  -H 'content-type: application/json' \
  -d '{"approvedBy":"buyer"}'

curl -X POST http://localhost:3000/approvals/<id>/reject \
  -H 'content-type: application/json' \
  -d '{"rejectedBy":"buyer"}'

curl http://localhost:3000/orders/<order-id>/receipt
```

## Red-team suite

Run the 14 core attack scenarios against a fresh mandate per scenario:

```bash
npm run redteam -- --set=core
```

Each run persists an `attack_runs` row with the full scenario results and prints pass counts per category. Any failure prints the full decision trail: mandate, cart, history, deterministic verdict and reasons, intent result, and final verdict.

The held-out set contains 12 independently generated attack variants. It is not used to tune the guard rules:

```bash
npm run redteam -- --set=heldout
```

Regenerate the held-out artifact with the configured model when needed:

```bash
npm run redteam:generate-heldout
```

The generated file is `apps/api/src/redteam/heldout.generated.json`.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run prisma:validate
```

## Environment

Every variable is documented in `.env.example`. The env loader validates configuration at startup and exits with a clear message if anything is missing or invalid.

## License

MIT
