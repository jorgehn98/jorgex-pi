# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their Pi-specific representation and lifecycle.

This private development package is not an end-user release. It publishes the PR01 foundation contract plus a dormant, versioned snapshot of the reviewed JorgeX Stack assets, but implements no runtime capabilities yet.

## Current boundary

| Area | Current state |
| --- | --- |
| Compatibility | Tested only with Pi `0.84.2`; the contract does not claim a wider range. |
| Pi resources | `extensions`, `skills`, `prompts`, and `themes` are declared as empty arrays. |
| Canonical snapshot | 15 agents and 17 complete skill trees (96 files) from JorgeX Stack commit `6d2b98b1728e275bf97920f9712dd4b7928de6a7`. |
| Package assets | `contract/assets.v1.json` owns the parity manifest, skills, and agent snapshot; it declares no external writes. |
| Companions | Supply-chain metadata is audited, but no companion is installed, bundled, or activated. |
| Runtime commands | The package publishes neither a runner nor command schemas. Their behavior and schemas are designed together in PR06. |

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

`pnpm install --frozen-lockfile` provisions `@earendil-works/pi-coding-agent@0.84.2` as an exact development dependency. The lifecycle test invokes that local Pi entrypoint with isolated home, cache, workspace, and `PI_CODING_AGENT_DIR` paths, so verification does not depend on a globally installed Pi. Pi itself is not bundled in the tarball and is not a runtime dependency of `jorgex-pi`.

### Refresh and verify the canonical snapshot

Regenerate only from a local JorgeX Stack checkout that contains the pinned commit:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" pnpm snapshot:generate
```

The generator reads raw Git objects at the exact SHA, ignoring replacement refs; it does not use live working-tree content or download upstream assets. It produces `snapshot/agents`, `skills`, and `contract/parity.v1.json` deterministically and publishes the three together as one transaction. If publication fails, the prior generation is restored. The generated assets contain 15 agents and all 96 files from the 17 approved skill trees.

Run the explicit cross-repository parity check against the same checkout:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" node --test tests/cross-repo/snapshot-parity.test.mjs
```

Skills are preserved byte-for-byte. Agent sources are normalized to LF for portable output, so the parity manifest records separate source and output SHA-256 hashes. A general `git diff --check` can therefore report the three reviewed trailing-whitespace occurrences inherited from the canonical skills; the hashes in `contract/parity.v1.json` are the parity authority. The development-only generator and transaction modules under `scripts/` are excluded from the published tarball.

The package is currently `private` with the development version `0.0.0-development`. There is therefore no valid installation command for users yet. After a reviewed release is published, installation will use Pi's package manager with an exact version:

```bash
pi install npm:jorgex-pi@<published-version>
```

That `pi install` invocation is the narrow package-manager exception: Pi must register and resolve its own package. It does not permit npm for repository development, release preparation, or unrelated dependency management.

## Paths and ownership

Pi may relocate its agent directory through `PI_CODING_AGENT_DIR`. Future lifecycle code must honor the value selected by Pi instead of assuming a fixed user path. The current package does not write there or anywhere outside the package.

The ownership boundary is `contract/assets.v1.json`. Only paths explicitly declared as package-owned may later be synchronized or removed; user files and resources owned by other packages remain outside that boundary. The current manifest owns `contract/parity.v1.json`, `skills`, and `snapshot/agents`, while `externalWrites` remains empty.

## Supply chain and security

`contract/components.v1.json` records the reviewed companion candidates with exact versions and npm `sha512` integrity values. No version floats, no companion dependency is present, and installation performs no live GitHub download. A later PR must separately activate and verify each selected component.

The repository contains no keys, tokens, credentials, or secret placeholders. The snapshot adds no runner, command schemas, network integration, hooks, project bootstrap, permission policy, Engram setup, model policy, active subagents, web access, goals, custom theme, or startup branding. Activation begins in the next capability PR; this snapshot PR only packages reviewed, hash-verifiable bytes.
