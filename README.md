# Mandate Guard

A spending-authorization layer for AI shopping agents. Every PayPal tool call is checked against a user-defined mandate and recorded in an audit log.

## Status

Stage 0: monorepo scaffold. No PayPal, AI, or business logic yet.

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
