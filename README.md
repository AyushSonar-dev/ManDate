# Mandate Guard

A spending-authorization layer for AI shopping agents. Every PayPal tool call is checked against a user-defined mandate and recorded in an audit log.

## Status

Stage 5: mock and Channel3 storefronts, plus a guarded PayPal shopping agent with a CLI.

## Requirements

- Node.js 18.18+
- Docker (for PostgreSQL)

## Setup

```bash
npm install
cp .env.example .env
npm run db:up
npm run prisma:generate
```

## Development

```bash
npm run dev
```

The API listens on `http://localhost:3000`. Check health:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## Shopping agent

Create a mandate through `POST /mandates`, then run the agent:

```bash
npm run agent -- --mandate <id> "buy wireless headphones under 40 dollars"
```

The agent searches the storefront, inspects full product pages, and calls the guarded PayPal `create_order` tool. Every reasoning step, tool call and tool result is logged. A blocked or approval-required order never reaches PayPal.

The mock catalog (`apps/api/data/catalog.json`) is the default and is used by tests and the red-team suite. For the live demo, set `STOREFRONT_PROVIDER=channel3` and `CHANNEL3_API_KEY`. Channel3 responses are cached under `CHANNEL3_CACHE_DIR`; set `CHANNEL3_OFFLINE=true` to replay cached responses without network access or an API key.

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
