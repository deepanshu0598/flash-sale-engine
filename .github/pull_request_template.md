## What changed and why

<!-- The "why" matters more than the "what" — the diff already shows what changed. -->

## How was this tested?

- [ ] `npm test` (unit)
- [ ] `npm run test:e2e`
- [ ] Manually verified against a running instance (describe how, if applicable)

## Checklist

- [ ] No secrets, credentials, or `.env` values committed
- [ ] If this touches an entity: a migration is included (`npm run migration:generate`), not just `synchronize`
- [ ] If this touches `purchase()` or the Lua scripts: the no-oversell e2e test still passes
- [ ] README / LEARNING.md updated if this changes architecture, endpoints, or trade-offs described there
