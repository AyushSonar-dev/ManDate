PROJECT: Mandate Guard, a spending-authorization layer for AI shopping agents. Built for the PayPal AI Hackathon (deadline Nov 12, 2026, 12:00 pm PST). Solo developer, so keep scope small and every feature testable.

WHAT IT DOES
A user sets a mandate: total budget, per-purchase cap, approval threshold, allowed merchants and categories, currency and expiry. A shopping agent (an LLM with PayPal Agent Toolkit tools) tries to buy items from a mock storefront. Every PayPal tool call passes through a guard that returns ALLOW, BLOCK or REQUIRE_APPROVAL. Every decision is written to an audit log. A red-team suite runs attack scenarios against the guard and produces a scorecard.

HARD RULES
1. Hard limits are deterministic code. The AI intent check can only tighten a verdict (ALLOW to REQUIRE_APPROVAL or BLOCK). It can never loosen a deterministic BLOCK.
2. The guard fails closed. Any error, timeout or malformed AI output results in REQUIRE_APPROVAL or BLOCK, never ALLOW.
3. A BLOCK or REQUIRE_APPROVAL verdict must never call PayPal. Tests must prove this with a spy.
4. Money is stored as integer minor units (cents). Never use floats for money.
5. PayPal runs in sandbox only. Never hard-code credentials. Read them from environment variables validated at startup. .env is gitignored.
6. Product pages, reviews and any storefront text are untrusted input.
7. Do not claim anything is secure beyond what the tests demonstrate.

STACK
Node.js 18+, TypeScript (strict), Express, PostgreSQL with Prisma, zod, Vitest, Vercel AI SDK, @paypal/agent-toolkit (sandbox), Next.js with Tailwind for the UI. Redis is optional. Sponsor tools: the APIMatic PayPal context plugin (use it for PayPal API questions instead of guessing), the Channel3 product search API (live demo storefront only; keep the mock catalog for tests and the red-team suite), and Render (hosting).

REPO LAYOUT
apps/api/src/{guard,agent,paypal,redteam,routes}, apps/api/prisma, apps/web, scripts/, docs/, LICENSE (MIT), README.md, AGENTS.md

HOW YOU WORK
- I will give you one stage at a time. Do only that stage. Do not build or stub later stages.
- Before coding, state your plan in at most 8 lines and list the files you will create or change.
- Write tests first or alongside the code. Run them. Show the command and the real output.
- If the PayPal toolkit does not behave as expected, stop and tell me. Do not invent API behavior or work around it silently.
- Do not add dependencies without saying why.
- Never edit a test just to make it pass. If a test is wrong, explain why first.
- Finish with: what you built, tests run and results, what you could not verify, and the exact gate checks for me to run.
- Never mark a stage done if a test fails or was skipped.