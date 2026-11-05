# Releasing

Releases are automated but switched off. Nothing has been released or published yet, and publishing stays blocked until the checklist below is done.

The plan is approved: release-please, npm trusted publishing (OIDC) and the target repository `iurysza/agent-topology-studio`. Activation is not approved. The repository stays private for now. A private repository does not block publishing to npm. Making it public is optional and needs a new instruction.

## How a release works

1. Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org/). `fix:` bumps the patch version. `feat:` bumps the minor version. Before 1.0.0, a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) also bumps the minor version.
2. On each push to `main`, `.github/workflows/release-please.yml` opens or updates a release pull request. It bumps `version` in `package.json` and `package-lock.json` and adds an entry to `CHANGELOG.md`.
3. Merging the release pull request makes a `vX.Y.Z` tag and a GitHub release.
4. The published release starts `.github/workflows/release.yml`. It runs the full CI workflow (`ci.yml`) on the tag, then the publish job:
   - checks out the tag
   - checks that the tagged commit is on `main`
   - runs `scripts/check-release.js`, which fails unless the tag is `v` plus the `package.json` version, the name is `agent-topology-studio`, `repository` points at the repository running the workflow, the registry is npmjs.org, `private` is not `true` and the licence is not `UNLICENSED`
   - runs `npm publish --access public`, which signs in through npm trusted publishing (OIDC). `NPM_CONFIG_PROVENANCE` is `true` from a public repository and `false` from a private one, because npm does not generate provenance for private repositories

Draft releases, prereleases and tags without a leading `v` do not publish.

## The first release

`.release-please-manifest.json` records `0.1.0`, the current version, as already released. So the first release pull request proposes the next version from the commits after the bootstrap point, for example `0.2.0` after a `feat:`. Version 0.1.0 was never tagged or published. Nothing forces a version (`release-as`). If the first public version must be exactly 0.1.0, decide that before activation.

release-please reads commits since the last release tag. With no tag yet, it reads the whole history of `main`, so a fresh history keeps the first changelog short. A fresh history needs its own approval.

## Safety switches

- Both workflows run only when the repository variable `RELEASE_AUTOMATION_ENABLED` is `true` and the repository is `iurysza/agent-topology-studio`. Unset, empty or `false` means off. CI runs as normal either way.
- `package.json` `private: true` and a private GitHub repository are different things. The first always blocks publishing. The second only means the package ships without provenance.
- Pull requests never receive release secrets. The release workflows do not run on `pull_request`.
- Default permissions are `contents: read`. Only the release-please job gets `contents: write` and `pull-requests: write`. Only the publish job gets `id-token: write`.
- Each workflow runs one at a time (`concurrency`, no cancelling).
- The tag reaches shell steps only through environment variables, never through `${{ }}` inside a script.

## Activation checklist

Each step needs its own approval. None of them is done.

1. Verify that `web/src/styles.css` and the theme initializer in `web/index.html` are the original replacements, and check their provenance record. Then resolve the 3 components with confirmed code overlap with machine (FSL-1.1-MIT): `web/src/parts.tsx`, `web/src/graph.tsx` and `web/src/editor.tsx`. A comparison with upstream found real implementation overlap, not only credit comments. That is not a legal determination. Resolve them before an MIT release.
2. In a separate change, set the chosen licence in `package.json` and add a matching licence file.
3. In a separate change, remove `"private": true` from `package.json`.
4. Only after a separate explicit instruction, create `iurysza/agent-topology-studio` as a private repository and set `repository` in `package.json` to it. Making it public, and publishing a fresh history, each need their own later approval. Neither is needed to publish.
5. Add the repository secret `RELEASE_PLEASE_TOKEN`: a fine-grained personal access token for that one repository with Contents read and write and Pull requests read and write. A release made with the default `GITHUB_TOKEN` would not start `release.yml`.
6. Create a GitHub environment named `npm`. Add reviewers to it if a person should approve each publish.
7. On npmjs.com, add a trusted publisher for `agent-topology-studio`: GitHub Actions, repository `iurysza/agent-topology-studio`, workflow `release.yml`, environment `npm`. If the package does not exist on npm yet, the first publish may need a one-off manual step. That needs separate approval, and no npm token is stored in the repository.
8. Set the repository variable `RELEASE_AUTOMATION_ENABLED` to `true`.

The publish job pins npm 11.16.0 on Node 22.18.0. Trusted publishing needs npm 11.5.1 or later and Node 22.14 or later.

## Turning it off

Set `RELEASE_AUTOMATION_ENABLED` to `false` or delete it.
