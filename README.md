# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their Pi-specific representation and lifecycle.

PR01 is a private development foundation, not an end-user release. It publishes a versioned machine-readable contract and reserves Pi's native resource lists, but implements no runtime capabilities yet.

## Current boundary

| Area | PR01 state |
| --- | --- |
| Compatibility | Tested only with Pi `0.84.2`; the contract does not claim a wider range. |
| Pi resources | `extensions`, `skills`, `prompts`, and `themes` are declared as empty arrays. |
| Package assets | `contract/assets.v1.json` declares no resources and no external writes. |
| Companions | Supply-chain metadata is audited, but no companion is installed, bundled, or activated. |
| Runtime commands | JSON schemas define future contracts; `status`, `doctor`, `models`, `sync`, and cleanup commands are not implemented. |

Component status is deliberate:

- `planned` identifies an approved candidate without a completed package audit.
- `audited` records an exact version, license, and npm integrity digest. It does not make the component executable or installed.
- `active` is reserved for a later PR that deliberately wires a component into the package and verifies its lifecycle.

## Development

Use pnpm for repository work:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm pack
```

The package is currently `private` with the development version `0.0.0-development`. There is therefore no valid installation command for users yet. After a reviewed release is published, installation will use Pi's package manager with an exact version:

```bash
pi install npm:jorgex-pi@<published-version>
```

That `pi install` invocation is the narrow package-manager exception: Pi must register and resolve its own package. It does not permit npm for repository development, release preparation, or unrelated dependency management.

## Paths and ownership

Pi may relocate its agent directory through `PI_CODING_AGENT_DIR`. Future lifecycle code must honor the value selected by Pi instead of assuming a fixed user path. PR01 does not write there or anywhere outside the package.

The ownership boundary is `contract/assets.v1.json`. Only paths explicitly declared as package-owned may later be synchronized or removed; user files and resources owned by other packages remain outside that boundary. The PR01 manifest contains `resources: []` and `externalWrites: []`.

## Supply chain and security

`contract/components.v1.json` records the reviewed companion candidates with exact versions and npm `sha512` integrity values. No version floats, no companion dependency is present, and installation performs no live GitHub download. A later PR must separately activate and verify each selected component.

The repository contains no keys, tokens, credentials, or secret placeholders. PR01 adds no network integration, hooks, project bootstrap, permission policy, Engram setup, model policy, subagents, web access, goals, custom theme, or startup branding. Those capabilities remain outside this foundation until their dedicated PRs.
