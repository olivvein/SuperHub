# SDK npm Publish Guide

This guide explains how to publish a new npm version when the SuperHub TypeScript client package is updated.

## Package Identity

- Workspace path: `packages/sdk`
- npm package: `@olivvein/superhub-sdk`
- Current access: `public`

## When To Publish

Publish a new version after changes in the SDK package, typically:

- `packages/sdk/src/**`
- `packages/sdk/bin/**`
- `packages/sdk/examples/**` (if shipped examples changed)
- `packages/sdk/package.json`

## Release Steps

Run from repository root:

```bash
# 1) Authenticate (if needed)
npm_config_cache=/tmp/.npm-cache npm whoami || npm_config_cache=/tmp/.npm-cache npm login

# 2) Choose one release command
npm run release:sdk:patch   # patch bump + build + dry-run + publish
# npm run release:sdk:minor
# npm run release:sdk:major
```

If version is already bumped and you only want to publish:

```bash
npm run publish:sdk
```

## Post Publish Checks

```bash
npm_config_cache=/tmp/.npm-cache npm view @olivvein/superhub-sdk version
npm_config_cache=/tmp/.npm-cache npm view @olivvein/superhub-sdk versions --json
```

Install test:

```bash
npm install @olivvein/superhub-sdk@latest
```

## Troubleshooting

### `Access token expired or revoked`

```bash
npm_config_cache=/tmp/.npm-cache npm logout
npm_config_cache=/tmp/.npm-cache npm login
```

### `404 Not Found` on publish

Cause: logged in user does not have publish rights for the package scope.

- For `@olivvein/*`: publish with user `olivvein`.
- For an org scope (example: `@superhub/*`): user must be `owner`/`maintainer` in that org.

If needed, switch package name to your own scope:

```bash
npm pkg set --workspace packages/sdk name="@<your-npm-user>/superhub-sdk"
npm pkg set --workspace packages/sdk publishConfig.access="public"
```

### `EPERM` with `.npm/_cacache`

Use a temp cache:

```bash
npm_config_cache=/tmp/.npm-cache npm publish --workspace packages/sdk --access public
```

### `You cannot publish over the previously published versions`

Bump the version again:

```bash
npm run sdk:version:patch
```

### `npm warn publish ... auto-corrected errors`

Apply npm fixes:

```bash
npm pkg fix --workspace packages/sdk
```

Then rerun build + dry-run + publish.
