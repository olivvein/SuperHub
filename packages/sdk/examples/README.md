# @superhub/sdk Examples

These examples are bundled with the SDK package so you can copy them in any Node/React project.

## Copy examples into your project

```bash
npx --no-install superhub-examples ./superhub-examples
```

## Prepare env

```bash
cp superhub-examples/.env.example superhub-examples/.env
set -a
source superhub-examples/.env
set +a
```

## Node examples

```bash
# Music provider
npx tsx superhub-examples/node/music-provider.ts

# Music controller
npx tsx superhub-examples/node/music-controller.ts

# ISS realtime monitor (works with python iss-updater)
npx tsx superhub-examples/node/iss-monitor.ts
```

## React example

Files under `superhub-examples/react/`:
- `useSuperHub.ts`
- `IssPanel.tsx`

Import and render `IssPanel` in your app. The example uses `@superhub/sdk` and reads:
- `VITE_HUB_HTTP_URL`
- `VITE_HUB_TOKEN`
