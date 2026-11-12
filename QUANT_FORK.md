# Quant Pi

This is the Pi fork for [Quant Agent](https://github.com/mwtakoolchi/quant_agent).
The initial integration branch is `quant/v1.5.1`, based on upstream tag
`v1.5.1` (`dd30101cfc5b0609411dd80b6f93adbc14db14cf`). Upstream's MIT license
and attribution remain in place. Package names stay unchanged so the SDK
dependency graph can be consumed as one coherent artifact set.

The fork owns terminal/session SDK customizations. Quant Agent owns account
selection, research tools, local service adapters and the `qagent` launcher.
`quant-daemon` remains the Rust trading authority. The supported product entry
point is Quant Agent's `qagent`, not the upstream coding CLI bundled in the SDK.
There is no separate exchange client or order path in this fork.

The first customization sets the product name, terminal title and default state
namespace. Quant Agent supplies its own explicit tools, model transport and
private session directory through the SDK. It disables ambient extensions,
shell tools, telemetry, cache warming and automatic provider retries.

## Upstream updates

Keep `origin` pointing to `mwtakoolchi/quant-pi` and `upstream` pointing to
`earendil-works/pi`. Pin a released upstream tag; `main` can contain unreleased
changes. Do not update an installed product directly from a moving branch.

For a new release, fetch upstream tags and create a candidate branch from the
current Quant integration branch, then merge the selected release tag. Resolve
and review the small customization delta. Read API/provider changes, regenerate
the dependency lock if required with install hooks disabled, then run:

```sh
npm ci --ignore-scripts
npm run build
npm run check
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/quant-identity.test.ts test/config.test.ts
cd ../..
node scripts/pack-packages.mjs --offline-model-data --out .artifacts/quant-packages
```

Run package tests from their package directory as required by `AGENTS.md`.
`npm run build` fetches public model catalog data; it does not require provider
credentials. These catalog responses can change independently of the source
tag. Preserve the reviewed tarball cohort for exact restoration, including its
catalog bytes. `npm run hydrate:model-data` hydrates values without rewriting
typed wrappers; `npm run build:offline` can then reuse those values.
The pack command copies the reviewed source into a private temporary snapshot,
checks its bytes, then cleans and rebuilds that snapshot before packing. It
does not overwrite the checkout's dist or run install hooks. Manifest v2 binds
the build mode and source digest. `--skip-build` is diagnostic only: it marks
artifacts source-unbound, and Quant Agent refuses to adopt or hydrate them.

Quant Agent must consume the complete required Pi package cohort from this
artifact set and record both source and tarball hashes. Its account transports,
tool routing, session restore, cancellation, unknown-result handling and actual
terminal startup/exit tests must pass before selecting the new product package.
Exchange validation is separate; a Pi upgrade must not automatically launch a
trading runtime. Keep the previous installed product available for rollback.

Do not commit `node_modules`, `dist`, tarballs, sessions, local account files or
provider credentials. Remove temporary build outputs after consumer acceptance;
keep selected product packages and the source/artifact receipts needed to
reproduce them.
