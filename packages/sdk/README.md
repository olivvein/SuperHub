# @olivvein/superhub-sdk

TypeScript SDK for SuperHub clients (Node.js and browser).

## Install

```bash
npm install @olivvein/superhub-sdk
```

In your code:

```ts
import { HubClient } from "@olivvein/superhub-sdk";
```

## Examples

After install, scaffold bundled examples:

```bash
npx --no-install superhub-examples ./superhub-examples
```

## Publish (maintainers)

Full runbook:

```bash
npm_config_cache=/tmp/.npm-cache npm whoami || npm_config_cache=/tmp/.npm-cache npm login
npm run release:sdk:patch
# or: npm run release:sdk:minor
# or: npm run release:sdk:major
```

Publish only (no version bump):

```bash
npm run publish:sdk
```

For troubleshooting and scope/auth errors, see `docs/SDK_NPM_PUBLISH_GUIDE.md`.
