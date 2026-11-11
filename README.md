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
npm run dev      # API on http://localhost:4000
npm run dev:web  # web console on http://localhost:3000
```

The API listens on the port set by `PORT` (default `4000`). Check health:

```bash
curl http://localhost:4000/health
# {"ok":true}
```

## Web console

Open `http://localhost:3000`. The web app proxies `/api/*` to `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`).

- `/mandate` creates and displays the current spending mandate.
- `/run` starts an asynchronous shopping-agent run, then polls it for status and guarded decisions.
- `/approvals` lists pending approvals and resolves them.
- `/orders/[id]` shows an order receipt, decision trail, rules, and approvals.
- `/scorecard` shows the latest persisted red-team run.

Starting a run returns `202` with a run id immediately. The agent executes in the background, and the run moves to `COMPLETED` or `FAILED` with a readable error. The supporting API endpoints are `GET /mandates/:id/decisions`, `GET /scorecard/latest`, `POST /agent/runs`, and `GET /agent/runs/:id`.

## Shopping agent

Create a mandate through `POST /mandates`, then run the agent:

```bash
npm run agent -- --mandate <id> "buy wireless headphones under 40 dollars"
```

The agent searches the storefront, receives full product pages from a single `search_catalog` call (at most 3 results), and calls the guarded PayPal `create_order` tool. Every reasoning step, tool call and tool result is logged. Runs are capped at 5 model steps, and a blocked or approval-required order never reaches PayPal.

The web console starts runs asynchronously instead of holding the HTTP request open:

```bash
curl -X POST http://localhost:4000/agent/runs \
  -H 'content-type: application/json' \
  -d '{"mandateId":"<id>","prompt":"buy wireless headphones under 40 dollars"}'
# 202 {"runId":"<run-id>","run_id":"<run-id>","status":"RUNNING"}

curl http://localhost:4000/agent/runs/<run-id>
# {"id":"<run-id>","status":"COMPLETED"|"FAILED", ..., "decisions":[...]}
```

## LLM providers

`LLM_CHAIN` is an ordered list of `provider:model` entries. Supported providers are `groq`, `cerebras`, `gemini`, and `openrouter`. The agent only falls back to the next entry on an HTTP `429` or `5xx`, and never after a tool call has executed. Each entry uses one retry.

```bash
LLM_CHAIN=groq:llama-3.3-70b-versatile,cerebras:llama-3.3-70b,gemini:gemini-2.5-flash
GROQ_API_KEY=...
CEREBRAS_API_KEY=...
GEMINI_API_KEY=...
```

Use an optional `INTENT_MODEL` to run the intent check on a different provider or model. Per-provider request budgets are configured with `LLM_RPM_GROQ`, `LLM_RPM_CEREBRAS`, `LLM_RPM_GEMINI`, and `LLM_RPM_OPENROUTER`; the agent waits instead of sending over-budget requests.

Run the free-tier model check to verify each chain entry against the mock catalog. It uses a PayPal `create_order` spy, so it never calls PayPal:

```bash
npm run model-check
```

After the deterministic rules return `ALLOW`, a second intent check compares the user's original request with the proposed cart. Product names and other cart text are passed to the model as untrusted, delimited data. A partial or mismatched intent, malformed JSON, a model error, or a timeout all require approval. A deterministic `BLOCK` is never loosened. Configure the timeout with `INTENT_TIMEOUT_MS` (default 5000).

The mock catalog (`apps/api/data/catalog.json`) is the default and is used by tests and the red-team suite. For the live demo, set `STOREFRONT_PROVIDER=channel3` and `CHANNEL3_API_KEY`. Channel3 responses are cached under `CHANNEL3_CACHE_DIR`; set `CHANNEL3_OFFLINE=true` to replay cached responses without network access or an API key.

## Approvals and receipts

When the guard returns `REQUIRE_APPROVAL`, review the pending approval:

```bash
curl http://localhost:4000/approvals?status=PENDING
```

Approving re-runs the guard before anything is sent to PayPal. If the order is still allowed, the API creates a PayPal sandbox order and returns `202 PENDING_BUYER_APPROVAL` with the approval link. Approve the order in the PayPal sandbox, then call approve again to capture it. Spent budget is only updated after a `COMPLETED` capture.

```bash
curl -X POST http://localhost:4000/approvals/<id>/approve \
  -H 'content-type: application/json' \
  -d '{"approvedBy":"buyer"}'

curl -X POST http://localhost:4000/approvals/<id>/reject \
  -H 'content-type: application/json' \
  -d '{"rejectedBy":"buyer"}'

curl http://localhost:4000/orders/<order-id>/receipt
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
