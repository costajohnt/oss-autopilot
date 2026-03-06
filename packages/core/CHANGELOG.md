# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.44.17](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.16...core-v0.44.17) (2026-03-06)


### Bug Fixes

* improve plugin update detection in session-start hook ([#585](https://github.com/costajohnt/oss-autopilot/issues/585)) ([1ea8ec6](https://github.com/costajohnt/oss-autopilot/commit/1ea8ec6e5c44be8d4a5142bea0f85939eaec84ad))

## [0.44.16](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.15...core-v0.44.16) (2026-03-06)


### Bug Fixes

* apply minStars filter to dashboard closed PR count and treat unknown stars as excluded ([#583](https://github.com/costajohnt/oss-autopilot/issues/583)) ([965a253](https://github.com/costajohnt/oss-autopilot/commit/965a253b331eb5e2cdc54e1a7de775417bcbd624)), closes [#576](https://github.com/costajohnt/oss-autopilot/issues/576)

## [0.44.15](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.14...core-v0.44.15) (2026-03-06)


### Bug Fixes

* correct release-please output keys for root path ([#581](https://github.com/costajohnt/oss-autopilot/issues/581)) ([e517574](https://github.com/costajohnt/oss-autopilot/commit/e517574093386bdc4d4a941d6353f101ab90e723))

## [0.44.14](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.13...core-v0.44.14) (2026-03-06)


### Bug Fixes

* remove release.yml that races with release-please for GitHub releases ([#579](https://github.com/costajohnt/oss-autopilot/issues/579)) ([c5f898c](https://github.com/costajohnt/oss-autopilot/commit/c5f898c6506e1a108159f7a2404bddb51853d5d5))

## [0.44.13](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.12...core-v0.44.13) (2026-03-06)


### Bug Fixes

* filter historical stats by min stars and replace dismiss/snooze with status override ([#577](https://github.com/costajohnt/oss-autopilot/issues/577)) ([739ee7a](https://github.com/costajohnt/oss-autopilot/commit/739ee7a10106eb42c10dcf57dd7167978d825fec))

## [0.44.12](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.11...core-v0.44.12) (2026-03-06)


### Bug Fixes

* auto-pull marketplace clone when update is available ([#573](https://github.com/costajohnt/oss-autopilot/issues/573)) ([4f6cba6](https://github.com/costajohnt/oss-autopilot/commit/4f6cba6d350e5206edb711e513da0d12b1238e2c))

## [0.44.11](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.10...core-v0.44.11) (2026-03-06)


### Bug Fixes

* update check fails to parse release tag with component prefix ([#571](https://github.com/costajohnt/oss-autopilot/issues/571)) ([5319a27](https://github.com/costajohnt/oss-autopilot/commit/5319a278b35af4a2fb7f8a2e4146f271b31ee266))

## [0.44.10](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.9...core-v0.44.10) (2026-03-06)


### Bug Fixes

* recognize CI bot commits and build dashboard SPA before startup ([#569](https://github.com/costajohnt/oss-autopilot/issues/569)) ([516f8cc](https://github.com/costajohnt/oss-autopilot/commit/516f8cc33699e4a2142d6662be0035677523d8f6))

## [0.44.9](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.8...core-v0.44.9) (2026-03-05)


### Bug Fixes

* update stale comments referencing removed changes_addressed status ([#565](https://github.com/costajohnt/oss-autopilot/issues/565)) ([b779465](https://github.com/costajohnt/oss-autopilot/commit/b7794653bacbb8dbad3db8fa12cf225847ef4be9))

## [0.44.8](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.7...core-v0.44.8) (2026-03-05)


### Bug Fixes

* eliminate ReDoS vulnerability in analyzeRequirements regex ([#557](https://github.com/costajohnt/oss-autopilot/issues/557)) ([3b99da6](https://github.com/costajohnt/oss-autopilot/commit/3b99da66539b230d7542581e8730208c1f8d78a7))

## [0.44.7](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.6...core-v0.44.7) (2026-03-05)


### Bug Fixes

* address all open repo audit findings ([#547](https://github.com/costajohnt/oss-autopilot/issues/547)-[#553](https://github.com/costajohnt/oss-autopilot/issues/553)) ([#555](https://github.com/costajohnt/oss-autopilot/issues/555)) ([4b98a5c](https://github.com/costajohnt/oss-autopilot/commit/4b98a5c6771e1504b6237ff6ea38807c075f62f5))

## [0.44.6](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.5...core-v0.44.6) (2026-03-04)


### Bug Fixes

* exclude own repos from PR counts and filter by star count ([#544](https://github.com/costajohnt/oss-autopilot/issues/544)) ([12eeeaa](https://github.com/costajohnt/oss-autopilot/commit/12eeeaa5a7ebc369714f9c880d5f39a6ff3f8fa7))
* resolve hono security vulnerabilities via pnpm overrides ([#546](https://github.com/costajohnt/oss-autopilot/issues/546)) ([eaf90b1](https://github.com/costajohnt/oss-autopilot/commit/eaf90b1e5f1b59909cd6ef069562e0950bc670e5))

## [0.44.5](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.4...core-v0.44.5) (2026-03-04)


### Bug Fixes

* merge monthly counts into existing state instead of overwriting ([#538](https://github.com/costajohnt/oss-autopilot/issues/538)) ([ae8c418](https://github.com/costajohnt/oss-autopilot/commit/ae8c418b824616bc7cef77c6998bebe9bb7466a4))

## [0.44.4](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.3...core-v0.44.4) (2026-03-04)


### Bug Fixes

* **hooks:** prevent --silent from being passed to tsc during dashboard build ([82dc1b3](https://github.com/costajohnt/oss-autopilot/commit/82dc1b3b562470abce0d05629c7f4ca421aeb1d8))
* **release:** track all plugin files in core releases, not just packages/core ([f95ebe0](https://github.com/costajohnt/oss-autopilot/commit/f95ebe0d6bb42d607f64b1a3eda2b3c9ad495534))
* **release:** track hooks, workflows, and plugin config in core releases ([a065a3c](https://github.com/costajohnt/oss-autopilot/commit/a065a3c0bf6ea1821e6a9048feb0ec48a9cef496))

## [0.44.3](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.2...core-v0.44.3) (2026-03-04)


### Bug Fixes

* resolve 10 audit issues — security, reliability, bugs, consolidation ([#534](https://github.com/costajohnt/oss-autopilot/issues/534)) ([b5c41ad](https://github.com/costajohnt/oss-autopilot/commit/b5c41ad818528506ca6735bcf58638db4df177e8))

## [0.44.2](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.1...core-v0.44.2) (2026-03-04)


### Bug Fixes

* remove dead code — unused exports, test factories, and type re-exports ([#532](https://github.com/costajohnt/oss-autopilot/issues/532)) ([34e09cb](https://github.com/costajohnt/oss-autopilot/commit/34e09cbabdd98f4e978bbef55721ad308661c3e5))

## [0.44.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.0...core-v0.44.1) (2026-03-03)


### Bug Fixes

* add escapeHtml XSS tests and consolidate duplicate test factories ([#510](https://github.com/costajohnt/oss-autopilot/issues/510)) ([de805ff](https://github.com/costajohnt/oss-autopilot/commit/de805ffbb3792b2bbf375375e77d89654d138f63)), closes [#486](https://github.com/costajohnt/oss-autopilot/issues/486)
* add search result caching, project health caching, and repo score TTL ([#511](https://github.com/costajohnt/oss-autopilot/issues/511)) ([b8802ca](https://github.com/costajohnt/oss-autopilot/commit/b8802ca2d175a789c310156088ccd21ee1e93167)), closes [#487](https://github.com/costajohnt/oss-autopilot/issues/487)
* exclude cli-registry.ts from coverage thresholds ([#516](https://github.com/costajohnt/oss-autopilot/issues/516)) ([91aaa66](https://github.com/costajohnt/oss-autopilot/commit/91aaa66be38626b31a11bd3aaa6c71214f29897f))
* extract CLI command registry, fix build config ([#488](https://github.com/costajohnt/oss-autopilot/issues/488)) ([#512](https://github.com/costajohnt/oss-autopilot/issues/512)) ([22d8e55](https://github.com/costajohnt/oss-autopilot/commit/22d8e55778d9310e58f32db70cdc1199e35a345f))
* filter dismissed PRs from dashboard Action Required section ([#507](https://github.com/costajohnt/oss-autopilot/issues/507)) ([9a1b04e](https://github.com/costajohnt/oss-autopilot/commit/9a1b04eb08ffabfafe070986acfe40833b565e67)), closes [#501](https://github.com/costajohnt/oss-autopilot/issues/501)
* prevent self-reply filter from silencing maintainer follow-up questions ([#505](https://github.com/costajohnt/oss-autopilot/issues/505)) ([dec498d](https://github.com/costajohnt/oss-autopilot/commit/dec498dc0dcf5449709a0e7283f4deeaceda41dc)), closes [#498](https://github.com/costajohnt/oss-autopilot/issues/498)
* resolve prettier formatting violations across 11 files ([#515](https://github.com/costajohnt/oss-autopilot/issues/515)) ([d3327be](https://github.com/costajohnt/oss-autopilot/commit/d3327bebb860be805df99982c4bf83f165244a4c))
* return ci_blocked instead of failing_ci for non-actionable CI failures ([#509](https://github.com/costajohnt/oss-autopilot/issues/509)) ([fa3192c](https://github.com/costajohnt/oss-autopilot/commit/fa3192cf4546c9e6e392804dac7f6bbd459fae6d)), closes [#502](https://github.com/costajohnt/oss-autopilot/issues/502)

## [0.44.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.43.1...core-v0.44.0) (2026-03-03)


### Features

* SPA dashboard with static HTML fallback, cold-start fix, recent activity ([#497](https://github.com/costajohnt/oss-autopilot/issues/497)) ([47e9f26](https://github.com/costajohnt/oss-autopilot/commit/47e9f26f5e43534e955b3da69b53c1413578edab))

## [0.43.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.43.0...core-v0.43.1) (2026-03-03)


### Bug Fixes

* resolve 7 open issues — security, validation, reliability, testing, performance ([#495](https://github.com/costajohnt/oss-autopilot/issues/495)) ([38a795c](https://github.com/costajohnt/oss-autopilot/commit/38a795c02963ae9bca0493f575ba7a1910dd419e))

## [0.43.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.6...core-v0.43.0) (2026-03-03)


### Features

* launch interactive SPA dashboard from startup ([#493](https://github.com/costajohnt/oss-autopilot/issues/493)) ([ee3ab26](https://github.com/costajohnt/oss-autopilot/commit/ee3ab2643658edb916e11b9e9e6420bca9e8090a))

## [0.42.6](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.5...core-v0.42.6) (2026-03-02)


### Bug Fixes

* handle GitHub Search API failures on deep pagination of merged PR counts ([#477](https://github.com/costajohnt/oss-autopilot/issues/477)) ([6ea06bc](https://github.com/costajohnt/oss-autopilot/commit/6ea06bc289efeea3a8f738a70bd994fbbfa037fb))

## [0.42.5](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.4...core-v0.42.5) (2026-03-02)


### Bug Fixes

* harden input validation, error handling, and documentation accuracy ([#474](https://github.com/costajohnt/oss-autopilot/issues/474)) ([690eea2](https://github.com/costajohnt/oss-autopilot/commit/690eea2d0a08588e10b7a8dad07950a28588695e))

## [0.42.4](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.3...core-v0.42.4) (2026-03-02)


### Bug Fixes

* auto-undismiss PRs on new activity and re-throw commit date rate limits ([#468](https://github.com/costajohnt/oss-autopilot/issues/468), [#469](https://github.com/costajohnt/oss-autopilot/issues/469)) ([#472](https://github.com/costajohnt/oss-autopilot/issues/472)) ([ceba992](https://github.com/costajohnt/oss-autopilot/commit/ceba992b1d8899d5fc5a63c06ace68af33e36a54))

## [0.42.3](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.2...core-v0.42.3) (2026-03-02)


### Bug Fixes

* review follow-ups for [#431](https://github.com/costajohnt/oss-autopilot/issues/431) and [#416](https://github.com/costajohnt/oss-autopilot/issues/416) ([#470](https://github.com/costajohnt/oss-autopilot/issues/470)) ([9375c1f](https://github.com/costajohnt/oss-autopilot/commit/9375c1feb0627900cb6d27988959816e99d4a671))

## [0.42.2](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.1...core-v0.42.2) (2026-03-02)


### Bug Fixes

* dismiss command accepts PR URLs and filters them from actionable items ([#416](https://github.com/costajohnt/oss-autopilot/issues/416)) ([#464](https://github.com/costajohnt/oss-autopilot/issues/464)) ([20f6f3c](https://github.com/costajohnt/oss-autopilot/commit/20f6f3cec5c47a6e0524679dfd8f82377690c89a))
* include CHANGES_REQUESTED reviews with empty body in timeline ([#431](https://github.com/costajohnt/oss-autopilot/issues/431)) ([#462](https://github.com/costajohnt/oss-autopilot/issues/462)) ([4b8f664](https://github.com/costajohnt/oss-autopilot/commit/4b8f664f2367b6659dadd05b76e1c1bb10138277))
* remove dead code, extract Phase 2/3 helper, and add error path tests ([#414](https://github.com/costajohnt/oss-autopilot/issues/414)) ([#465](https://github.com/costajohnt/oss-autopilot/issues/465)) ([1d8cd3b](https://github.com/costajohnt/oss-autopilot/commit/1d8cd3b9a7bc2c59f2d2acb82bda4951278fb9d3))

## [0.42.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.42.0...core-v0.42.1) (2026-03-02)


### Bug Fixes

* use ValidationError consistently in validation.ts ([#437](https://github.com/costajohnt/oss-autopilot/issues/437)) ([#443](https://github.com/costajohnt/oss-autopilot/issues/443)) ([6650806](https://github.com/costajohnt/oss-autopilot/commit/665080634880a36610030216a81d76e958a66fbb))


### Performance Improvements

* add time-based caching for merged/closed PR count API calls ([#449](https://github.com/costajohnt/oss-autopilot/issues/449)) ([ff0132f](https://github.com/costajohnt/oss-autopilot/commit/ff0132fa1281c5027823bb891dc1e06b2e17f291))

## [0.42.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.41.0...core-v0.42.0) (2026-03-02)


### Features

* add MCP server package (Phase 4) ([#429](https://github.com/costajohnt/oss-autopilot/issues/429)) ([ca336be](https://github.com/costajohnt/oss-autopilot/commit/ca336be7df44bfdc758d00a8e88719159f5cf894))
* Phase 3 — interactive dashboard with Preact + Vite ([#427](https://github.com/costajohnt/oss-autopilot/issues/427)) ([ed2959f](https://github.com/costajohnt/oss-autopilot/commit/ed2959f2b6d879e94af6fff9aea24cf2f82383c8))

## [0.41.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.40.1...core-v0.41.0) (2026-03-01)


### Features

* Phase 2 — npm publish setup for @oss-autopilot/core ([#426](https://github.com/costajohnt/oss-autopilot/issues/426)) ([7395e5c](https://github.com/costajohnt/oss-autopilot/commit/7395e5c108ea2a487028befb354a5138966e2992))


### Bug Fixes

* release-please paths and hook robustness ([#424](https://github.com/costajohnt/oss-autopilot/issues/424)) ([ed759eb](https://github.com/costajohnt/oss-autopilot/commit/ed759ebf69f9c2f029c723f93c21d3170297868a))

## [0.40.1](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.40.0...oss-autopilot-v0.40.1) (2026-02-28)


### Bug Fixes

* validate AskUserQuestion responses to prevent auto-pilot behavior ([#413](https://github.com/costajohnt/oss-autopilot/issues/413)) ([5e96531](https://github.com/costajohnt/oss-autopilot/commit/5e96531fcd009cd8e0325a15fb355f67ee5be5ab))

## [0.40.0](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.39.1...oss-autopilot-v0.40.0) (2026-02-28)


### Features

* add /oss-help quick reference command ([#360](https://github.com/costajohnt/oss-autopilot/issues/360)) ([#401](https://github.com/costajohnt/oss-autopilot/issues/401)) ([fe1cf31](https://github.com/costajohnt/oss-autopilot/commit/fe1cf31033c314ec1916291279d0d4469ceb2fad))
* add cross-references between all 7 agents ([#361](https://github.com/costajohnt/oss-autopilot/issues/361)) ([#402](https://github.com/costajohnt/oss-autopilot/issues/402)) ([0af5763](https://github.com/costajohnt/oss-autopilot/commit/0af576358a837032f8c9dc6862157492b701e1e3))
* add Phase 3 search for actively maintained repos ([#349](https://github.com/costajohnt/oss-autopilot/issues/349)) ([#390](https://github.com/costajohnt/oss-autopilot/issues/390)) ([1712ddd](https://github.com/costajohnt/oss-autopilot/commit/1712ddd8daa655cf228dff43be63d7161bf60815))
* add ROADMAP.md and enable GitHub Discussions ([#355](https://github.com/costajohnt/oss-autopilot/issues/355)) ([#398](https://github.com/costajohnt/oss-autopilot/issues/398)) ([6d76094](https://github.com/costajohnt/oss-autopilot/commit/6d76094cb16b9eacf543aca9023a70ceaff726d3))
* add SBOM generation to release workflow ([#359](https://github.com/costajohnt/oss-autopilot/issues/359)) ([#400](https://github.com/costajohnt/oss-autopilot/issues/400)) ([ca513ef](https://github.com/costajohnt/oss-autopilot/commit/ca513eff185798875e9faf4dc7265ac83bec7ed8))
* add security scanning to pre-commit-reviewer agent ([#367](https://github.com/costajohnt/oss-autopilot/issues/367)) ([#407](https://github.com/costajohnt/oss-autopilot/issues/407)) ([520c633](https://github.com/costajohnt/oss-autopilot/commit/520c633b23154805fb21f61dbcd512bffccd253a))
* auto-check CONTRIBUTING.md compliance before creating PRs ([#391](https://github.com/costajohnt/oss-autopilot/issues/391)) ([a7ec3d5](https://github.com/costajohnt/oss-autopilot/commit/a7ec3d53214e0d324b344af34487bfaee510d72f))
* run project linter/formatter before committing ([#375](https://github.com/costajohnt/oss-autopilot/issues/375)) ([#395](https://github.com/costajohnt/oss-autopilot/issues/395)) ([7338587](https://github.com/costajohnt/oss-autopilot/commit/73385874b00ac3dcc659e052bfdc641ccf705c22))


### Bug Fixes

* add end-to-end contribution walkthrough to README ([#365](https://github.com/costajohnt/oss-autopilot/issues/365)) ([#405](https://github.com/costajohnt/oss-autopilot/issues/405)) ([af9de23](https://github.com/costajohnt/oss-autopilot/commit/af9de2365a55ae3816e46b9e759b9b7588a97791))
* add missing standard fields to plugin.json manifest ([#376](https://github.com/costajohnt/oss-autopilot/issues/376)) ([2d12dd0](https://github.com/costajohnt/oss-autopilot/commit/2d12dd0d7b5f31b4edc29fe24eb854e87bb9c1c2)), closes [#344](https://github.com/costajohnt/oss-autopilot/issues/344)
* change default file permissions from 0o644 to 0o600 in atomicWriteFileSync ([#380](https://github.com/costajohnt/oss-autopilot/issues/380)) ([3fcc361](https://github.com/costajohnt/oss-autopilot/commit/3fcc361bb7a039936abcd816fa86e0790caae1cb)), closes [#357](https://github.com/costajohnt/oss-autopilot/issues/357)
* detect prior contributions via GitHub API during vetting ([#393](https://github.com/costajohnt/oss-autopilot/issues/393)) ([9ceb3b7](https://github.com/costajohnt/oss-autopilot/commit/9ceb3b7e63ea8812f7b0064264bbd772024c2a76))
* document branch protection rules and RELEASE_TOKEN management ([#366](https://github.com/costajohnt/oss-autopilot/issues/366)) ([#406](https://github.com/costajohnt/oss-autopilot/issues/406)) ([2737439](https://github.com/costajohnt/oss-autopilot/commit/27374398ce4d64054b04e7f31191d6ee4f1e2f94))
* document curated issue list file format ([#364](https://github.com/costajohnt/oss-autopilot/issues/364)) ([#404](https://github.com/costajohnt/oss-autopilot/issues/404)) ([3618b00](https://github.com/costajohnt/oss-autopilot/commit/3618b004c8d419bc8eeba0dc533000f715605d7c))
* document health-check hook and improve error handling ([#362](https://github.com/costajohnt/oss-autopilot/issues/362)) ([#403](https://github.com/costajohnt/oss-autopilot/issues/403)) ([ffd7bff](https://github.com/costajohnt/oss-autopilot/commit/ffd7bff470e9957b041606b53310ad77e0471a1d))
* exclude dist/ from vitest test discovery ([#384](https://github.com/costajohnt/oss-autopilot/issues/384)) ([08c1b07](https://github.com/costajohnt/oss-autopilot/commit/08c1b074be816b88170c52c45b77e790eda4725d))
* filter issue replies to only maintainers and [@mentions](https://github.com/mentions) ([#343](https://github.com/costajohnt/oss-autopilot/issues/343)) ([#389](https://github.com/costajohnt/oss-autopilot/issues/389)) ([c50d5a5](https://github.com/costajohnt/oss-autopilot/commit/c50d5a5a44ce86dced957c30e110fdc6d3893ed6))
* gracefully handle rate limits in search instead of crashing ([#383](https://github.com/costajohnt/oss-autopilot/issues/383)) ([5126b6a](https://github.com/costajohnt/oss-autopilot/commit/5126b6a40a9836f80ef5a5ef553bce528c5afd84))
* raise CI coverage thresholds to match actual coverage ([#353](https://github.com/costajohnt/oss-autopilot/issues/353)) ([#396](https://github.com/costajohnt/oss-autopilot/issues/396)) ([cf4cb28](https://github.com/costajohnt/oss-autopilot/commit/cf4cb282c3317e90ad133e9babf891052d319134))
* remove legacy data path references from agents ([#378](https://github.com/costajohnt/oss-autopilot/issues/378)) ([4427ce6](https://github.com/costajohnt/oss-autopilot/commit/4427ce6178e0db782f4f00182bd02a1f51b9f0f7)), closes [#346](https://github.com/costajohnt/oss-autopilot/issues/346)
* remove unused type imports from issue-discovery.ts ([#410](https://github.com/costajohnt/oss-autopilot/issues/410)) ([4f2a069](https://github.com/costajohnt/oss-autopilot/commit/4f2a06981ae2ab74f3144eafe44b17f876ac7f4f))
* replace Record&lt;string, any&gt; with Record&lt;string, unknown&gt; in issue-conversation.ts ([#381](https://github.com/costajohnt/oss-autopilot/issues/381)) ([3f27536](https://github.com/costajohnt/oss-autopilot/commit/3f27536c13589d3a68b35ab3d95805d232fd41ac)), closes [#363](https://github.com/costajohnt/oss-autopilot/issues/363)
* require explicit user approval before posting PR comments ([#394](https://github.com/costajohnt/oss-autopilot/issues/394)) ([20066e3](https://github.com/costajohnt/oss-autopilot/commit/20066e3057025e3dda7167962b601a408e0beb77))
* resolve contradictory test requirement guidance in pr-compliance-checker ([#379](https://github.com/costajohnt/oss-autopilot/issues/379)) ([4b78666](https://github.com/costajohnt/oss-autopilot/commit/4b786665a259a6ee08179e5995378a51481f79f8))
* respect 'any' language preference in CLI search ([#382](https://github.com/costajohnt/oss-autopilot/issues/382)) ([a4f1f6e](https://github.com/costajohnt/oss-autopilot/commit/a4f1f6e8fe6686ec355c41042992259b957378d3)), closes [#350](https://github.com/costajohnt/oss-autopilot/issues/350)
* share spam repo filter across all search strategies ([#385](https://github.com/costajohnt/oss-autopilot/issues/385)) ([9685e1f](https://github.com/costajohnt/oss-autopilot/commit/9685e1fee04cfe0b1dc42eed2ef51e6299d52678)), closes [#352](https://github.com/costajohnt/oss-autopilot/issues/352)
* verify build targets and file paths before testing instructions ([#392](https://github.com/costajohnt/oss-autopilot/issues/392)) ([0188218](https://github.com/costajohnt/oss-autopilot/commit/01882187de1e7a3b53082cf6ab5aca9a333db5a4))

## [0.39.1](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.39.0...oss-autopilot-v0.39.1) (2026-02-28)


### Bug Fixes

* improve agent safety guardrails (draft-to-file, review-aware commits, pre-push review) ([#341](https://github.com/costajohnt/oss-autopilot/issues/341)) ([36a0ab8](https://github.com/costajohnt/oss-autopilot/commit/36a0ab893df362a23176c1a7ef37453d4aae784e))

## [0.39.0](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.38.0...oss-autopilot-v0.39.0) (2026-02-27)


### Features

* add GitHub username validation for search queries ([#318](https://github.com/costajohnt/oss-autopilot/issues/318)) ([ba4c97a](https://github.com/costajohnt/oss-autopilot/commit/ba4c97a2c8ed0c2b1d53881a13fe7cc0b08eb72e))
* add HTTP caching with ETags for repo metadata ([#326](https://github.com/costajohnt/oss-autopilot/issues/326)) ([c82d6ef](https://github.com/costajohnt/oss-autopilot/commit/c82d6ef11b80e535e1c631f5b7fa8fa6f404e528))
* add maintainer detection and merge conflict resolution strategies ([#328](https://github.com/costajohnt/oss-autopilot/issues/328)) ([157a242](https://github.com/costajohnt/oss-autopilot/commit/157a2422b64ac2226adfff4cb769616f8ec380f5))
* add offline mode for dashboard and status commands ([#325](https://github.com/costajohnt/oss-autopilot/issues/325)) ([6b79877](https://github.com/costajohnt/oss-autopilot/commit/6b79877b74a2e1d77362a5a07009264b724430f0)), closes [#296](https://github.com/costajohnt/oss-autopilot/issues/296)


### Bug Fixes

* add missing isFromMaintainer property and type imports ([#335](https://github.com/costajohnt/oss-autopilot/issues/335)) ([cab892e](https://github.com/costajohnt/oss-autopilot/commit/cab892e60e0218dcdd76c23f90f7dfc9fa17e135))
* improve pre-commit review with targeted re-dispatch and committed change detection ([#324](https://github.com/costajohnt/oss-autopilot/issues/324)) ([c04a30d](https://github.com/costajohnt/oss-autopilot/commit/c04a30d6e636ec72656634d5ede45702dd4d5e5c))
* reduce startup JSON output size by deduplicating PR objects ([#331](https://github.com/costajohnt/oss-autopilot/issues/331)) ([cea2683](https://github.com/costajohnt/oss-autopilot/commit/cea2683b4cdbe12650d6c5f37921b808a27c34a5))
* remove unused fetchRepoStarCountsImpl import ([#336](https://github.com/costajohnt/oss-autopilot/issues/336)) ([021fb36](https://github.com/costajohnt/oss-autopilot/commit/021fb363c49e41c610a2202453cd7bf9ff0cb371))
* resolve prettier formatting issues in daily.ts and dashboard.ts ([#337](https://github.com/costajohnt/oss-autopilot/issues/337)) ([a1860d3](https://github.com/costajohnt/oss-autopilot/commit/a1860d398c79a06693a0de62d21db966aa6cb2d4))


### Performance Improvements

* reduce cold start latency with lazy imports and async token fetch ([#327](https://github.com/costajohnt/oss-autopilot/issues/327)) ([a795b88](https://github.com/costajohnt/oss-autopilot/commit/a795b88af079a5d5a8d2ead2694b0af2263b9232))

## [0.38.0](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.37.0...oss-autopilot-v0.38.0) (2026-02-27)


### Features

* add CI coverage thresholds to prevent regression ([#273](https://github.com/costajohnt/oss-autopilot/issues/273)) ([#301](https://github.com/costajohnt/oss-autopilot/issues/301)) ([b1539e1](https://github.com/costajohnt/oss-autopilot/commit/b1539e106eafbebf13c3a1c3c3562f8eb2c31c8d))
* add macOS CI runner to test matrix ([#279](https://github.com/costajohnt/oss-autopilot/issues/279)) ([#302](https://github.com/costajohnt/oss-autopilot/issues/302)) ([cc0b88a](https://github.com/costajohnt/oss-autopilot/commit/cc0b88a75dc4df7e48da73cd7ce742bd3608371e))


### Bug Fixes

* update rollup to patch high-severity path traversal vulnerability ([#285](https://github.com/costajohnt/oss-autopilot/issues/285)) ([8a3347b](https://github.com/costajohnt/oss-autopilot/commit/8a3347b15331ae0a22fba0a507d9d63441c0c35f))

## [0.37.0](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.5...oss-autopilot-v0.37.0) (2026-02-25)


### Features

* add --debug flag with verbose logging ([#228](https://github.com/costajohnt/oss-autopilot/issues/228)) ([#255](https://github.com/costajohnt/oss-autopilot/issues/255)) ([6486426](https://github.com/costajohnt/oss-autopilot/commit/648642644eb5c97decc9cbf9c37c40466ebf333b))
* add concurrent state write protection ([#254](https://github.com/costajohnt/oss-autopilot/issues/254)) ([4bca582](https://github.com/costajohnt/oss-autopilot/commit/4bca582286a0c71afefa1329e5a7c1aebea682d4))
* dashboard improvements — filtering, dark mode, search ([#257](https://github.com/costajohnt/oss-autopilot/issues/257)) ([5e639c1](https://github.com/costajohnt/oss-autopilot/commit/5e639c1176659b60e8e739cb5c8e2682c265769e))


### Bug Fixes

* add comment pagination for issues with 100+ comments ([#233](https://github.com/costajohnt/oss-autopilot/issues/233)) ([#250](https://github.com/costajohnt/oss-autopilot/issues/250)) ([a3f5cbd](https://github.com/costajohnt/oss-autopilot/commit/a3f5cbdcdbb5093248b30799699bc0fb4f64179a))
* harden input validation for CLI arguments ([#251](https://github.com/costajohnt/oss-autopilot/issues/251)) ([81c21ab](https://github.com/costajohnt/oss-autopilot/commit/81c21abf9b62b3eb38699edff53fb05becd671f5))
* narrow error handling for review comment fetch ([#243](https://github.com/costajohnt/oss-autopilot/issues/243)) ([ed247ff](https://github.com/costajohnt/oss-autopilot/commit/ed247ffa2d2fca1a15fe5c3a8b303cf713a20288))

## [0.36.5](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.4...oss-autopilot-v0.36.5) (2026-02-25)


### Bug Fixes

* dashboard repository breakdown respects star count filter ([#224](https://github.com/costajohnt/oss-autopilot/issues/224)) ([fd9d688](https://github.com/costajohnt/oss-autopilot/commit/fd9d68886eef744dfc73d7dc433efc5c8bafcfd0))

## [0.36.4](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.3...oss-autopilot-v0.36.4) (2026-02-25)


### Bug Fixes

* add GH_REPO env for CI dispatch in release-please workflow ([#221](https://github.com/costajohnt/oss-autopilot/issues/221)) ([fe4dfd3](https://github.com/costajohnt/oss-autopilot/commit/fe4dfd301e7eafd9598918055c8d6c2b87607844))
* auto-trigger CI on release-please PRs via workflow_dispatch ([#220](https://github.com/costajohnt/oss-autopilot/issues/220)) ([c3e5e10](https://github.com/costajohnt/oss-autopilot/commit/c3e5e10c032cc79f8ee63b1bbc73940f977d9ba0))
* push badge updates to separate branch to avoid branch protection ([#219](https://github.com/costajohnt/oss-autopilot/issues/219)) ([f8b2cb8](https://github.com/costajohnt/oss-autopilot/commit/f8b2cb8b300219be50bd7aea350977dba11bdc33))
* resolve TS18048 type-check error failing CI on all Node versions ([#217](https://github.com/costajohnt/oss-autopilot/issues/217)) ([1695127](https://github.com/costajohnt/oss-autopilot/commit/16951274d46e60ee6e8f1540393afdfc30ce8348))
* use PAT for release-please so its PRs trigger CI ([#222](https://github.com/costajohnt/oss-autopilot/issues/222)) ([490a7fc](https://github.com/costajohnt/oss-autopilot/commit/490a7fc4f9cfec74cd050d9890ea4145e7a5a4a4))

## [0.36.3](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.2...oss-autopilot-v0.36.3) (2026-02-24)


### Bug Fixes

* filter excluded repos/orgs from stats, clean state on exclude, enforce minStars ([#211](https://github.com/costajohnt/oss-autopilot/issues/211), [#212](https://github.com/costajohnt/oss-autopilot/issues/212), [#213](https://github.com/costajohnt/oss-autopilot/issues/213)) ([#214](https://github.com/costajohnt/oss-autopilot/issues/214)) ([148bff1](https://github.com/costajohnt/oss-autopilot/commit/148bff153c39381d6b3ef55ede753eab84042ce8))

## [0.36.2](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.1...oss-autopilot-v0.36.2) (2026-02-24)


### Bug Fixes

* address all open issues ([#192](https://github.com/costajohnt/oss-autopilot/issues/192), [#202](https://github.com/costajohnt/oss-autopilot/issues/202), [#203](https://github.com/costajohnt/oss-autopilot/issues/203), [#204](https://github.com/costajohnt/oss-autopilot/issues/204)) ([#209](https://github.com/costajohnt/oss-autopilot/issues/209)) ([c2a271d](https://github.com/costajohnt/oss-autopilot/commit/c2a271dc3dc59e5a7b2995ec937257a11fdbfd5a))

## [0.36.1](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.36.0...oss-autopilot-v0.36.1) (2026-02-24)


### Bug Fixes

* detect maintainer self-replies to avoid false positive needs_response ([#199](https://github.com/costajohnt/oss-autopilot/issues/199)) ([#200](https://github.com/costajohnt/oss-autopilot/issues/200)) ([d4f46d6](https://github.com/costajohnt/oss-autopilot/commit/d4f46d69bef6203920699592b03ab6e170059fe1))

## [0.36.0](https://github.com/costajohnt/oss-autopilot/compare/oss-autopilot-v0.35.0...oss-autopilot-v0.36.0) (2026-02-20)


### ⚠ BREAKING CHANGES

* PRs are now fetched fresh from GitHub on each run instead of being tracked locally in state.

### Features

* add batch vet workflow, diminishing returns detection, and stronger list nudge ([#111](https://github.com/costajohnt/oss-autopilot/issues/111)) ([d9b2721](https://github.com/costajohnt/oss-autopilot/commit/d9b27216e03b8ff0f7beb6449e292ee3104566c3)), closes [#107](https://github.com/costajohnt/oss-autopilot/issues/107)
* add checklist detection, action hints, and waiting-on-maintainer status ([#33](https://github.com/costajohnt/oss-autopilot/issues/33)) ([6dfc442](https://github.com/costajohnt/oss-autopilot/commit/6dfc44208ce39757fbc9eff7dd8ff37b5152f8d3))
* add dismiss/undismiss for issue reply notifications ([#191](https://github.com/costajohnt/oss-autopilot/issues/191)) ([d7d6d68](https://github.com/costajohnt/oss-autopilot/commit/d7d6d68f4209203d0d77b496da63141c29b463ee))
* add dismiss/undismiss for issue reply notifications ([#191](https://github.com/costajohnt/oss-autopilot/issues/191)) ([#193](https://github.com/costajohnt/oss-autopilot/issues/193)) ([d7d6d68](https://github.com/costajohnt/oss-autopilot/commit/d7d6d68f4209203d0d77b496da63141c29b463ee))
* add integration check, manual testing, and workflow guards ([#77](https://github.com/costajohnt/oss-autopilot/issues/77)) ([1319e1e](https://github.com/costajohnt/oss-autopilot/commit/1319e1e648aad72ce4193d57777164c2b91c342e))
* add issue conversation tracking ([#114](https://github.com/costajohnt/oss-autopilot/issues/114)) ([8ae00e8](https://github.com/costajohnt/oss-autopilot/commit/8ae00e8527dca322515ce6466376bad4e04b4ddb))
* add label-farming spam filter and repo quality signals to issue search ([#101](https://github.com/costajohnt/oss-autopilot/issues/101)) ([4724db4](https://github.com/costajohnt/oss-autopilot/commit/4724db444e73cb98402e754dd1539c10628a7a14))
* add merged-PR prioritization and rate limit handling to issue search ([#102](https://github.com/costajohnt/oss-autopilot/issues/102)) ([9147547](https://github.com/costajohnt/oss-autopilot/commit/91475479af50b56d5426b27e608f63fe065ad958))
* add parallel multi-strategy search and auto-exclude across rounds ([#112](https://github.com/costajohnt/oss-autopilot/issues/112)) ([dc3ec21](https://github.com/costajohnt/oss-autopilot/commit/dc3ec2174d4b86c8cee212318692ac35866cb495)), closes [#106](https://github.com/costajohnt/oss-autopilot/issues/106)
* add parse-issue-list, check-integration, and local-repos CLI commands ([#93](https://github.com/costajohnt/oss-autopilot/issues/93)) ([9149fc0](https://github.com/costajohnt/oss-autopilot/commit/9149fc08c95fd179cf91e3684b7c80a8e80da1a9))
* add plugin marketplace for /plugin discovery ([#9](https://github.com/costajohnt/oss-autopilot/issues/9)) ([85c2f16](https://github.com/costajohnt/oss-autopilot/commit/85c2f163aca6f78e31bebcf956cda5440bb009a4))
* add pre-commit code review step for quality gate before pushing ([#39](https://github.com/costajohnt/oss-autopilot/issues/39)) ([2cb9508](https://github.com/costajohnt/oss-autopilot/commit/2cb95080193d4e405cb8ae82a835c0ae875b8689))
* add pre-commit gate and conditional daily re-run in /oss workflow ([#95](https://github.com/costajohnt/oss-autopilot/issues/95)) ([c141214](https://github.com/costajohnt/oss-autopilot/commit/c1412141f4292efb4e8e1e29cc7233870ea4ca15))
* add pre-commit hooks enforcing workflow rules ([#42](https://github.com/costajohnt/oss-autopilot/issues/42)) ([ab35a37](https://github.com/costajohnt/oss-autopilot/commit/ab35a37c6b16dd4a313bc413b067d809a9d36bfc))
* add review agent scaling by diff size and post-response comment step ([#109](https://github.com/costajohnt/oss-autopilot/issues/109)) ([7d0eb5c](https://github.com/costajohnt/oss-autopilot/commit/7d0eb5c298b92b35cc6dfa8a9f688921bfe4b65d))
* add search result diversification filters (min stars, per-repo cap, doc filter) ([#110](https://github.com/costajohnt/oss-autopilot/issues/110)) ([23db158](https://github.com/costajohnt/oss-autopilot/commit/23db1582786431d9b442c3f237f8d1b69c1ed250)), closes [#105](https://github.com/costajohnt/oss-autopilot/issues/105)
* add three-phase multi-PR workflow and enriched PR display ([#104](https://github.com/costajohnt/oss-autopilot/issues/104)) ([e85de08](https://github.com/costajohnt/oss-autopilot/commit/e85de082f062480af420e8c5d26a7f1234d349d2))
* address all 6 open issues ([#187](https://github.com/costajohnt/oss-autopilot/issues/187)) ([4eacab6](https://github.com/costajohnt/oss-autopilot/commit/4eacab65bd4cf55edf1b08f8aad44fd498c904f3))
* AI policy detection with configurable repo blocklist ([#113](https://github.com/costajohnt/oss-autopilot/issues/113)) ([d28e502](https://github.com/costajohnt/oss-autopilot/commit/d28e502669fc5345704254a6b444e614f7c36ff7))
* auto-pull marketplace clone on session start ([#178](https://github.com/costajohnt/oss-autopilot/issues/178)) ([#179](https://github.com/costajohnt/oss-autopilot/issues/179)) ([deea6eb](https://github.com/costajohnt/oss-autopilot/commit/deea6eb6eeeda09c38b27686bade0afa3161f001))
* bundle CLI with esbuild for zero-install experience ([#34](https://github.com/costajohnt/oss-autopilot/issues/34)) ([13b1e35](https://github.com/costajohnt/oss-autopilot/commit/13b1e35a658fd0d7c2df1a34e1843c09bd84ebaf))
* classify infrastructure CI failures and make compliance check conditional ([#149](https://github.com/costajohnt/oss-autopilot/issues/149)) ([29a4b27](https://github.com/costajohnt/oss-autopilot/commit/29a4b272ff99522b54a8ee9b8533ea0743b84709))
* consolidate startup checks into single CLI command ([#126](https://github.com/costajohnt/oss-autopilot/issues/126)) ([94bd424](https://github.com/costajohnt/oss-autopilot/commit/94bd424f5f9b6c06bc1ced6c1a0cc9f00b4dae52))
* curated issue list integration + v0.4.0 release ([#35](https://github.com/costajohnt/oss-autopilot/issues/35)) ([b9fd389](https://github.com/costajohnt/oss-autopilot/commit/b9fd38993af893f4703324a36eaec733b9773220))
* dashboard visual redesign ([#66](https://github.com/costajohnt/oss-autopilot/issues/66)) ([da3c647](https://github.com/costajohnt/oss-autopilot/commit/da3c647780e477408e0d85683ea2fb2a4df77598))
* **dashboard:** update color scheme ([3c01654](https://github.com/costajohnt/oss-autopilot/commit/3c016541e13ec0a0b87a6ed934bdbf4e4fe775ed))
* **dashboard:** update color scheme ([fd7adbe](https://github.com/costajohnt/oss-autopilot/commit/fd7adbef6f4fb93105d1993ab6a7e9d2e0f0b5ee))
* draft-first PR workflow with iterative review cycles ([#61](https://github.com/costajohnt/oss-autopilot/issues/61)) ([c322954](https://github.com/costajohnt/oss-autopilot/commit/c32295459f7be8084f45a768f03009ae70a3365f)), closes [#59](https://github.com/costajohnt/oss-autopilot/issues/59)
* enrich daily --json with display labels, repo grouping, and CI classification ([#92](https://github.com/costajohnt/oss-autopilot/issues/92)) ([39c3884](https://github.com/costajohnt/oss-autopilot/commit/39c3884f7f7735e0a28646b1e45ccdced88bf43f))
* historical analytics dashboard with 4 chart enhancements ([#64](https://github.com/costajohnt/oss-autopilot/issues/64)) ([9719f65](https://github.com/costajohnt/oss-autopilot/commit/9719f65e2a8f441f7d758874a1c9c2e9cd1aaac9))
* hybrid CLI architecture with action-first UX and human-in-the-loop ([#5](https://github.com/costajohnt/oss-autopilot/issues/5)) ([53a51ec](https://github.com/costajohnt/oss-autopilot/commit/53a51ec4ad254443f970a964721db1049841ef1f))
* implement v2 fresh GitHub fetching architecture ([#27](https://github.com/costajohnt/oss-autopilot/issues/27)) ([fd32851](https://github.com/costajohnt/oss-autopilot/commit/fd3285150c72237c0da021cce3d944e3f192c5f5))
* improve daily check with rebase detection, action tiers, and new PR status categories ([#30](https://github.com/costajohnt/oss-autopilot/issues/30)) ([ee7dc7a](https://github.com/costajohnt/oss-autopilot/commit/ee7dc7a42bfc6f8f5e6807eb09fe4f0a56d1f157))
* marketing readiness polish — security, UX, governance ([#67](https://github.com/costajohnt/oss-autopilot/issues/67)) ([fbdd51f](https://github.com/costajohnt/oss-autopilot/commit/fbdd51f54276c6a2802cd42a973a041d2bac4914))
* modularize /oss skill prompt ([#164](https://github.com/costajohnt/oss-autopilot/issues/164)) ([82874dd](https://github.com/costajohnt/oss-autopilot/commit/82874dd753666acd2945bbe42d463def9cad27a6))
* pre-compute action menu in daily --json output ([9b8b2de](https://github.com/costajohnt/oss-autopilot/commit/9b8b2dee9c469023e46bd163c0c979ea610ef6c9))
* pre-compute action menu in daily --json output ([a588915](https://github.com/costajohnt/oss-autopilot/commit/a588915b9c37c3bcc71003f9626c73dbf4547b61)), closes [#78](https://github.com/costajohnt/oss-autopilot/issues/78)
* proactive PR health check, competitive positioning, and demo guide ([#45](https://github.com/costajohnt/oss-autopilot/issues/45)) ([c721e3d](https://github.com/costajohnt/oss-autopilot/commit/c721e3d8cd685d526d8724f770a79ea6c19a9f61))
* README rewrite, first-run welcome, and loading screen pattern ([#124](https://github.com/costajohnt/oss-autopilot/issues/124)) ([f45067f](https://github.com/costajohnt/oss-autopilot/commit/f45067f356a6112058f8ef2cdcaad3af2d08fe62))
* recently merged PRs in dashboard and daily digest ([#165](https://github.com/costajohnt/oss-autopilot/issues/165)) ([a9960d1](https://github.com/costajohnt/oss-autopilot/commit/a9960d10aefdef2bc905b7c935a85875ed500922))
* reduce /oss context window footprint ([#141](https://github.com/costajohnt/oss-autopilot/issues/141)) ([#159](https://github.com/costajohnt/oss-autopilot/issues/159)) ([803c2ec](https://github.com/costajohnt/oss-autopilot/commit/803c2ec298be785e2be11f5b5fc37fe00671a488))
* seamless plugin upgrade experience with stale bundle detection ([#40](https://github.com/costajohnt/oss-autopilot/issues/40)) ([b1c8123](https://github.com/costajohnt/oss-autopilot/commit/b1c81236692fdacf8292328c8f0b8bdf12176d20))
* shelve/unshelve PRs, consolidate dormancy, dashboard cleanup ([#158](https://github.com/costajohnt/oss-autopilot/issues/158)) ([#160](https://github.com/costajohnt/oss-autopilot/issues/160)) ([b365b5b](https://github.com/costajohnt/oss-autopilot/commit/b365b5b6975225c6083b0fbc9ae8d292fb2002e0))
* smarter issue search, enhanced repo scoring, and hardened type safety ([fbf56be](https://github.com/costajohnt/oss-autopilot/commit/fbf56be6f8effac704f64ae7cef4e1986d9c5a6b))
* track closed PRs for accurate merge rate and visibility ([#38](https://github.com/costajohnt/oss-autopilot/issues/38)) ([30cabe9](https://github.com/costajohnt/oss-autopilot/commit/30cabe95c58aa2521afb41307e0d2cce7878a56b))


### Bug Fixes

* add marketplace.json for plugin installation ([#115](https://github.com/costajohnt/oss-autopilot/issues/115)) ([d515748](https://github.com/costajohnt/oss-autopilot/commit/d51574810e272e60dd326a7a1942c6afa67b9db4))
* batch skill prompt fixes ([#133](https://github.com/costajohnt/oss-autopilot/issues/133), [#134](https://github.com/costajohnt/oss-autopilot/issues/134), [#135](https://github.com/costajohnt/oss-autopilot/issues/135), [#137](https://github.com/costajohnt/oss-autopilot/issues/137), [#144](https://github.com/costajohnt/oss-autopilot/issues/144)) ([#146](https://github.com/costajohnt/oss-autopilot/issues/146)) ([3b63b1c](https://github.com/costajohnt/oss-autopilot/commit/3b63b1ccae5cd8b3cab64a801cc9cea0cdeab205))
* CI failure overrides changes_addressed + acknowledgment comment filtering ([#70](https://github.com/costajohnt/oss-autopilot/issues/70)) ([0e3dfe0](https://github.com/costajohnt/oss-autopilot/commit/0e3dfe0cb7c33b6403c337fd1dad3e5c755b2346))
* classify PRs with changes_requested review as needs_changes instead of healthy ([844d5fd](https://github.com/costajohnt/oss-autopilot/commit/844d5fd7c1adc28856ae6166d1973a8adbafeb22))
* classify PRs with changes_requested review as needs_changes instead of healthy ([#48](https://github.com/costajohnt/oss-autopilot/issues/48)) ([afce57f](https://github.com/costajohnt/oss-autopilot/commit/afce57f6530416b94e9e20a8d50e9db857f77926))
* consolidate /oss loading into single tool call ([#125](https://github.com/costajohnt/oss-autopilot/issues/125)) ([024a8e0](https://github.com/costajohnt/oss-autopilot/commit/024a8e08948fcd6f760e3e4ea01debb4d5285444))
* correct health check script path to .claude-plugin/scripts/ ([#47](https://github.com/costajohnt/oss-autopilot/issues/47)) ([7aea26b](https://github.com/costajohnt/oss-autopilot/commit/7aea26b0645696e19c9d438b22125477d5d46009))
* correct marketplace.json schema for Claude Code plugin installation ([#96](https://github.com/costajohnt/oss-autopilot/issues/96)) ([63d1a72](https://github.com/costajohnt/oss-autopilot/commit/63d1a7215750651fc7eb2d16924f6d6cb496550d))
* deduplicate CI check runs to prevent false failure reports ([#36](https://github.com/costajohnt/oss-autopilot/issues/36)) ([51b1671](https://github.com/costajohnt/oss-autopilot/commit/51b16714a68966e605c1d35d633eb653fd17248d))
* detect changes_addressed status when contributor pushes after maintainer review ([#44](https://github.com/costajohnt/oss-autopilot/issues/44)) ([c38aa1a](https://github.com/costajohnt/oss-autopilot/commit/c38aa1ae323ca9b1ce0e51aae3c3c498ca3e8c74))
* display content before approval prompts ([#131](https://github.com/costajohnt/oss-autopilot/issues/131)) ([8f2588a](https://github.com/costajohnt/oss-autopilot/commit/8f2588aabea1714d636302e79f4d2723e7f6524f))
* don't prompt after informational responses ([#189](https://github.com/costajohnt/oss-autopilot/issues/189)) ([ab7ab7d](https://github.com/costajohnt/oss-autopilot/commit/ab7ab7ddda02d2434525e1252d964dbcc11f2c2a)), closes [#188](https://github.com/costajohnt/oss-autopilot/issues/188)
* enforce file permissions and add prompt injection defense ([#71](https://github.com/costajohnt/oss-autopilot/issues/71)) ([d0f19c4](https://github.com/costajohnt/oss-autopilot/commit/d0f19c4bfd5567b896efb2eaf4e1889db435f1a4))
* exclude recently closed PRs from "Need Attention" count ([#156](https://github.com/costajohnt/oss-autopilot/issues/156)) ([e5e107c](https://github.com/costajohnt/oss-autopilot/commit/e5e107c4cb7548c22fc27b61b12f12ea0a896fa1))
* exclude recently closed PRs from "Need Attention" count ([#156](https://github.com/costajohnt/oss-autopilot/issues/156)) ([#157](https://github.com/costajohnt/oss-autopilot/issues/157)) ([e5e107c](https://github.com/costajohnt/oss-autopilot/commit/e5e107c4cb7548c22fc27b61b12f12ea0a896fa1))
* exempt shelved PRs from excludeRepos/excludeOrgs filtering ([#175](https://github.com/costajohnt/oss-autopilot/issues/175)) ([#176](https://github.com/costajohnt/oss-autopilot/issues/176)) ([d2537e3](https://github.com/costajohnt/oss-autopilot/commit/d2537e3154598245e08ee6ed1dfca5d1af5108fc))
* filter bot comments from needs-response detection ([#143](https://github.com/costajohnt/oss-autopilot/issues/143)) ([#148](https://github.com/costajohnt/oss-autopilot/issues/148)) ([38dc6cf](https://github.com/costajohnt/oss-autopilot/commit/38dc6cf5737e058c75e60c4f4fa1bcb652f582b9))
* filter non-actionable CI statuses from capacity assessment ([#32](https://github.com/costajohnt/oss-autopilot/issues/32)) ([143f5f3](https://github.com/costajohnt/oss-autopilot/commit/143f5f351197e19af5ffaf3401401a4a3dacc180))
* health check always shows PR status summary on session start ([#53](https://github.com/costajohnt/oss-autopilot/issues/53)) ([dfec79f](https://github.com/costajohnt/oss-autopilot/commit/dfec79f6535c100994c05134d7be217ed4bb6cb9))
* improve PR status classification accuracy ([#151](https://github.com/costajohnt/oss-autopilot/issues/151), [#152](https://github.com/costajohnt/oss-autopilot/issues/152)) ([#153](https://github.com/costajohnt/oss-autopilot/issues/153)) ([8b76748](https://github.com/costajohnt/oss-autopilot/commit/8b767482105f2deb49abe07be1c652e5a3e3918c))
* move health check to .cjs file for Node.js 18-24+ compatibility ([#46](https://github.com/costajohnt/oss-autopilot/issues/46)) ([be5c0f3](https://github.com/costajohnt/oss-autopilot/commit/be5c0f33c0e52cdf0a53ac43d0b35bc18f37e8ee))
* populate merged PR counts from GitHub and add org/owner filtering ([#29](https://github.com/costajohnt/oss-autopilot/issues/29)) ([e270a7f](https://github.com/costajohnt/oss-autopilot/commit/e270a7f52373caf32064d3b9b04c71fa57d52386))
* pr-responder defers to user for visual demo requests ([#173](https://github.com/costajohnt/oss-autopilot/issues/173)) ([#177](https://github.com/costajohnt/oss-autopilot/issues/177)) ([316acfb](https://github.com/costajohnt/oss-autopilot/commit/316acfb799a34802ee0b7613f673eee20887cde3))
* reduce AI communication tells in PR responder and contribution skill ([#155](https://github.com/costajohnt/oss-autopilot/issues/155)) ([620778d](https://github.com/costajohnt/oss-autopilot/commit/620778d22f3d9623ea266e5230e2e1edb9ae68f9))
* remove static version badge to prevent release-please corruption ([#197](https://github.com/costajohnt/oss-autopilot/issues/197)) ([95519a5](https://github.com/costajohnt/oss-autopilot/commit/95519a5cd3d53be505b6108e1946e578de77402c))
* replace markdown SessionStart hook with command-based hooks.json format ([#52](https://github.com/costajohnt/oss-autopilot/issues/52)) ([4fac5da](https://github.com/costajohnt/oss-autopilot/commit/4fac5da5f10d0b364dc50abc95c2e9c03101eb3c))
* show SessionStart status to user via systemMessage ([#54](https://github.com/costajohnt/oss-autopilot/issues/54)) ([1e165c6](https://github.com/costajohnt/oss-autopilot/commit/1e165c68e5eea542b4dbebedd67f0de6089fb7a0))
* simplify action menu to always show search option ([#127](https://github.com/costajohnt/oss-autopilot/issues/127)) ([454a2cf](https://github.com/costajohnt/oss-autopilot/commit/454a2cf2dde9af36986c75b72de5070a1cf23bd8))
* split dashboard 'Attention Required' into actionable vs informational sections ([#63](https://github.com/costajohnt/oss-autopilot/issues/63)) ([0b3da8a](https://github.com/costajohnt/oss-autopilot/commit/0b3da8a343ea46225b62849c032b2fb00a1cefe4)), closes [#62](https://github.com/costajohnt/oss-autopilot/issues/62)
* use "./" instead of "." in marketplace.json source field ([#116](https://github.com/costajohnt/oss-autopilot/issues/116)) ([be9e463](https://github.com/costajohnt/oss-autopilot/commit/be9e46358419841f2e02761ce2e6e743245486d8))
* use merge-base for correct fork workflow diffs ([#142](https://github.com/costajohnt/oss-autopilot/issues/142), [#139](https://github.com/costajohnt/oss-autopilot/issues/139), [#138](https://github.com/costajohnt/oss-autopilot/issues/138)) ([#147](https://github.com/costajohnt/oss-autopilot/issues/147)) ([93b28c9](https://github.com/costajohnt/oss-autopilot/commit/93b28c9f4f5657d4f12f8a7a615edd688fd830a2))

## [0.35.0] - 2026-02-19

### Added

- **Dismiss/undismiss issue reply notifications (#191)** — New `dismiss <issue-url>` and `undismiss <issue-url>` CLI commands let users mute `new_response` notifications without posting a comment. Dismissed issues store a timestamp so new responses after the dismiss automatically resurface. Follows the existing shelve/unshelve pattern for PRs.

## [0.34.1] - 2026-02-18

### Fixed

- **Don't prompt after informational responses (#189)** — `AskUserQuestion` immediately after text output hides the content in Claude Code's UI. Softened Rule #5 to exempt informational questions, added a decision table for informational vs actionable inputs, and added UX rule #14 reinforcing the pattern.

## [0.34.0] - 2026-02-18

### Added

- **E2E smoke test for `startup --json` (#186)** — Integration test that runs the bundled CLI binary and validates JSON output structure, required fields (`version`, `setupComplete`), setup-incomplete handling, and execution speed (< 5 seconds). Uses an isolated HOME directory to avoid reading real user state.
- **Test coverage for startup dashboard-skip logic (#181)** — Unit tests verifying that `openInBrowser()` is skipped when `totalActivePRs === 0` (first run), called when PRs exist, and stays false when dashboard generation fails. Mocks `writeDashboardFromState`, `openInBrowser`, and `executeDailyCheck`.
- **Error path coverage for `getCIStatus` (#182)** — 8 new tests covering 401 (auth error), 403 (rate limit), 404 (silent), 500 (generic), network timeout, `listForRef` non-404 error logging, `listForRef` 404 silent handling, and empty SHA early return. Test count: 441 → 544.
- **npm publish workflow (#183)** — GitHub Actions workflow (`.github/workflows/npm-publish.yml`) that publishes to npm on release creation. Added `files` field to `package.json` to control published contents and `prepublishOnly` script for pre-publish validation. npm badge added to README.
- **Automated changelog via release-please (#185)** — Added `release-please-config.json`, `.release-please-manifest.json`, and `.github/workflows/release-please.yml` to automate version bumps and changelog generation from conventional commits.

### Changed

- **GitHub issue templates upgraded to YAML forms (#184)** — Converted `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md` from markdown to YAML form format (`.yml`), providing GitHub's structured form-based UI with required field validation, dropdowns for OS selection, and placeholder text for better issue reporting.

## [0.33.1] - 2026-02-18

### Fixed

- **PR responder no longer posts text-only "demos" (#173)** — When a maintainer asks for visual proof (screenshots, before/after demos, videos), the pr-responder agent now flags it to the user instead of generating a verbose text description. Visuals must come from the user, and text + visuals go in a single comment. Added to the "Avoiding AI Tells" section and the analysis process as an early check.

## [0.33.0] - 2026-02-18

### Added

- **Issue conversation tracking (#114)** — The `/oss` daily check now monitors GitHub issues the user has commented on (e.g., "Is this still relevant?", "I'd like to work on this") and surfaces maintainer responses. New `IssueConversationMonitor` class follows the `PRMonitor` pattern: stateless GitHub Search API fetch, bounded concurrency worker pool, bot filtering, and acknowledgment detection. Results appear in the daily summary, action menu ("Review N issue replies"), and HTML dashboard. The user can claim issues directly from the replies flow, feeding them into the existing `TrackedIssue` pipeline. Closes #114.
- `CommentedIssue` discriminated union type (`CommentedIssueWithResponse | CommentedIssueWithoutResponse`) and `IssueConversationStatus` in `src/core/types.ts`
- `IssueConversationMonitor` class with `fetchCommentedIssues()` in `src/core/issue-conversation.ts`
- `isAcknowledgmentComment()` exported utility for shared acknowledgment filtering (used by both `IssueConversationMonitor` and `PRMonitor`)
- `commentedIssues` field on `DailyOutput` for structured issue conversation data
- `hasIssueResponses`/`issueResponseCount` context flags on `ActionMenu`
- `issue_replies` action menu item when maintainer responses are detected
- Issue Conversations section in HTML dashboard with speech bubble icons
- "Handle Review Issue Replies" orchestration in `commands/oss.md`
- 30+ tests for issue conversation detection, bot filtering, acknowledgment filtering, and edge cases

### Changed

- **Bot filtering uses `isBotAuthor()` instead of `[bot]` substring** — Issue conversation monitor now uses the same comprehensive bot detection (12 known bot usernames) as `PRMonitor`, catching bots like `renovate`, `codecov-commenter`, and `netlify` that don't follow the `[bot]` suffix convention.
- **`computeActionMenu` accepts full `commentedIssues` and filters internally** — Previously accepted pre-filtered `issueResponses`, which could diverge from source data. Now filters `new_response` status internally for better encapsulation.

### Fixed

- **Null analysis results tracked in failures array** — When `analyzeIssueConversation` returns null (no user comment found despite search match), the issue is now recorded in the failures array instead of silently disappearing from both results and failures.

## [0.32.0] - 2026-02-18

### Changed

- **Modularize `/oss` skill prompt (#136)** — Split the monolithic 1,456-line `commands/oss.md` into a slim core router (~394 lines) plus 4 on-demand workflow files loaded via Read tool. The core router handles startup, daily check display, action menu, and routing; workflow files are only loaded when their specific path is entered. New files: `workflows/work-through-issues.md` (Phase A/B/C + pick-from-list), `workflows/pre-commit-review.md` (standard path for existing PRs), `workflows/draft-first-workflow.md` (new contribution full pipeline), `workflows/reference.md` (CLI commands + agent table). Reduces initial context window usage by 50-77% for common sessions.

## [0.31.0] - 2026-02-18

### Added

- **Recently Merged PRs in dashboard (#165)** — New "Recently Merged" section in both the HTML dashboard and daily digest, showing PRs merged in the last 7 days. Uses purple accent with git-merge icon, placed above the "Recently Closed" section. Adds `fetchRecentlyMergedPRs()` to `PRMonitor`, refactors `fetchRecentlyClosedPRs` into a shared `fetchRecentPRs<T>` generic helper, new `MergedPR` type, and `recentlyMergedPRs` field on `DailyDigest`.

## [0.30.1] - 2026-02-17

### Removed

- **Dead code cleanup of legacy v1 methods (#161)** — Removed 11 unused StateManager methods that were remnants of the v1 local PR tracking architecture: `findPR`, `updatePR`, `movePRToMerged`, `movePRToClosed`, `movePRToDormant`, `reactivatePR`, `moveDormantPRToMerged`, `moveDormantPRToClosed`, `updateIssue`, `removeIssue`, `linkIssueToPR`. Also removed the `PRHealthStatus` type and 4 dead interface fields (`TrackedPR.healthStatus`, `TrackedPR.pendingResponse`, `TrackedPR.linkedIssueNumber`, `TrackedIssue.linkedPRNumber`). Corresponding tests were also removed. Methods with active callers (`addActivePR`, `untrackPR`, `markPRAsRead`, `markAllPRsAsRead`, `addIssue`) are preserved.

## [0.30.0] - 2026-02-17

### Added

- **Shelve/unshelve PRs (#158)** — New `shelve <url>` and `unshelve <url>` CLI commands to manually exclude PRs from capacity and actionable issues. Shelved PRs appear in a dimmed section in the daily digest and dashboard, and are excluded from the PR capacity limit. PRs auto-unshelve when a maintainer engages (needs_response, needs_changes, failing_ci, merge_conflict), with a notification in both the digest and dashboard.

### Changed

- **Dormancy replaced by shelving** — Dormant PRs (30+ days inactive) are now automatically treated as shelved instead of appearing in separate "Dormant" and "Approaching Dormant" sections. They return to active automatically when activity resumes. The dashboard doughnut chart now shows Active/Shelved/Merged/Closed.
- **Capacity assessment excludes shelved PRs** — The capacity line now shows `(N/M PRs + K shelved)` when shelved PRs exist. Shelved PRs no longer count against `maxActivePRs`.
- **Dashboard shelved section** — Dashboard renders a dimmed "Shelved" section and an "Auto-Unshelved" notification section. Shelved PRs are filtered from the "Active Pull Requests" list.

### Removed

- **Dormant/Approaching Dormant sections** — Replaced by the unified shelving concept. Dormant PRs now appear in the "Shelved" section instead of separate dormancy sections.

## [0.29.0] - 2026-02-17

### Changed

- **Reduce `/oss` context window footprint (#141)** — Extracted the issue search workflow (~200 lines) into a standalone `/oss-search` command, replaced the legacy gh CLI fallback (~70 lines) with a short error message, condensed verbose sections (Draft PR Review Cycle, Squash + Reword, Integration Check, Action Tiers), and trimmed agent-covered content from SKILL.md. Net reduction: ~490 lines from `oss.md`, bringing typical session token usage down ~34%.

### Added

- **`/oss-search` command** — Self-contained issue search workflow extracted from `/oss`. Includes parallel multi-strategy search (established repos, CLI search, trending repos), batch vetting, and diminishing returns tracking.
- **Session scope guidance** — After completing a full implementation cycle (draft PR marked ready), a note suggests starting a fresh `/oss` session to free context.

## [0.28.1] - 2026-02-17

### Fixed

- **Recently closed PRs no longer counted as "Need Attention" (#156)** — PRs closed without merge were being included in the actionable issues list with priority numbers, inflating the "N need attention" count. They are now excluded from `actionableIssues` and displayed in a separate informational section. The `recently_closed` type has been removed from `ActionableIssueType`.

## [0.28.0] - 2026-02-17

### Changed

- **pr-responder agent: reduce AI communication tells** — Removed formulaic response templates ("Thanks for the review!", "Good catch!") that made drafted comments obviously AI-generated. Added guidance on varying tone, matching thread energy, and avoiding structured changelogs in PR comments. Agent now flags situations requiring human response (maintainer frustration, visual tasks, subjective decisions) instead of drafting a reply.
- **Contribution skill: writing style and escalation guidance** — Added "Writing Style (Avoiding AI Tells)" section covering the most common patterns that alert maintainers to automation. Added "When to Respond Personally" section identifying situations where the human contributor should respond directly.
- **OSS command: align post-response instructions** — Replaced structured changelog-style comment instructions in the "Post Response Comment" step with brief, natural-sounding guidance consistent with the new AI tells rules.

## [0.27.1] - 2026-02-14

### Fixed

- **Detect inline-only review comments as needing response (#151)** — Reviews with `COMMENTED` state but no top-level body (indicating inline review comments) are now included in the unresponded comment timeline. Previously, these were invisible to the detection logic, causing PRs with new review feedback after a commit to be classified as `changes_addressed` instead of `needs_response`.
- **Skip conditional checklist items from incomplete detection (#152)** — Unchecked checklist items containing conditional language like "(if the PR is ...)", "if applicable", "optional", or "N/A" are no longer counted as incomplete. This eliminates false-positive `incomplete_checklist` status for PRs in repos that use conditional checklists (e.g., n8n's backport label item).

## [0.27.0] - 2026-02-13

### Added

- **Infrastructure CI failure classification (#145)** — Jobs with `cancelled` or `timed_out` conclusions are now classified as `infrastructure` instead of `actionable`, skipping unnecessary investigation. Infrastructure-related check names (install dependencies, runner setup, service unavailable) are also detected. Conclusion data flows from GitHub API through to the classified checks output.

### Changed

- **Make compliance check conditional after draft-first workflow (#140)** — PRs that completed the full draft-first review cycle (Steps 5.6 → 5.6b → 5.7b → 5.7 → 5.8) now skip the compliance check automatically, since 5+ review agents already covered quality. Compliance check still runs for existing PR updates and quick fixes.

## [0.26.7] - 2026-02-13

### Fixed

- **Filter bot comments from "Needs Response" detection (#143)** — Bot accounts like CLAassistant, codecov-commenter, and changeset-bot (without the `[bot]` suffix) now correctly filtered alongside `[bot]`-suffixed accounts. PRs with only bot comments no longer trigger false positive investigation cycles.

## [0.26.6] - 2026-02-13

### Fixed

- **Use correct diff range for fork-based branches (#142)** — Replaced `origin/$baseBranch..HEAD` with `$(git merge-base origin/$baseBranch HEAD)..HEAD` in Steps 5.6, 5.6b, and 5.7. In fork workflows where `origin` is the fork, the old range included upstream commits, producing massive irrelevant diffs.
- **Add `--head` flag for fork-based `gh pr create` (#139)** — Step 0d now always uses `--head forkOwner:branch` with fallback detection if `gh repo view` fails, preventing "you must first push the current branch" errors on fork PRs.
- **Fix squash commit counting for forks (#138)** — Step 5.7 commit count now uses `$mergeBase..HEAD` instead of `origin/$baseBranch..HEAD`, with pre-flight validation before the destructive squash operation to guard against empty/invalid merge-base values.

## [0.26.5] - 2026-02-13

### Added

- **Manual testing auto-skip for non-visual changes (#134)** — Added auto-skip criteria to Step 5.7b so non-visual utility changes with passing automated tests bypass the manual testing prompt.
- **Branch prefix vs commit type mismatch (#135)** — Added guidance at issue claim time to choose a consistent change type (fix/feat/docs) for both branch prefix and commit message based on issue labels.

### Fixed

- **Force push refspec bash concatenation bug (#133)** — Simplified `git fetch origin "$branch:refs/remotes/origin/$branch"` to `git fetch origin "$branch"` to avoid shell quoting issues with the colon-separated refspec when chained via `&&` in bash commands.
- **CI re-run permission failures (#144)** — Added fallback guidance when `gh run rerun --failed` fails with permission or other errors on fork PRs. Suggests alternatives: empty commit retrigger, maintainer request, or waiting.
- **Full review tier for new contributions (#137)** — Strengthened Step 5.6 to explicitly override size-based scaling, ensuring the full Large-tier review suite is dispatched for new contributions regardless of diff size.

## [0.26.4] - 2026-02-12

### Fixed

- **Display content before approval prompts** — Diffs and drafted comments are now shown inline before presenting approval buttons, so users can review content before deciding.

## [0.26.3] - 2026-02-11

### Changed

- **README: expanded issue discovery coverage** — Added a "When You Search for Issues" showcase section with example output showing the 3-phase priority search, viability scoring, and spam filtering. Expanded the "Finding Contributions" usage section, enriched the feature table and comparison table, and strengthened the competitive positioning around relationship-aware search.

## [0.26.2] - 2026-02-11

### Changed

- **Added demo GIF to README** — Replaced static dashboard screenshot hero image with an animated GIF showing the full `/oss` workflow (typing command, loading, results with action menu). Moved dashboard screenshot to the Dashboard section where it's contextually relevant.

## [0.26.1] - 2026-02-11

### Changed

- **Simplified action menu** — Removed `view_healthy` and `view_details` options from the action menu. "Search for new issues" is now always available regardless of capacity, and the issue-list integration (pick from list / replenish) no longer requires `hasCapacity`. This makes the flow more action-oriented: address issues first, then pick new work or search.

## [0.26.0] - 2026-02-11

### Added

- **`startup` CLI command** — New command that combines auth check, setup check, daily fetch, dashboard generation, version detection, and issue list detection into a single CLI invocation. The `/oss` command's bash script shrinks from ~100 lines to ~8 lines, eliminating the multi-section delimiter parsing and reducing UI noise in Claude Code.
- **`executeDailyCheck()` export** — Extracted the core daily check logic from `runDaily` into a reusable exported function that returns `DailyOutput` without outputting. Used by the new `startup` command.
- **`writeDashboardFromState()` export** — Lightweight dashboard generation that reads from state (no GitHub re-fetch). Generates HTML and writes to `~/.oss-autopilot/dashboard.html`.
- **`IssueListInfo` and `StartupOutput` types** — New type definitions for the startup command's structured output.

### Changed

- **Simplified `/oss` bash script** — Replaced ~100-line inline script with an ~8-line version that calls `startup --json`. Delimiter-based parsing (`---DAILY_JSON---`, `---VERSION---`, `---ISSUE_LIST---`) replaced with single JSON envelope parsing.

## [0.25.1] - 2026-02-11

### Changed

- **Consolidated `/oss` loading into a single tool call** - Version detection and issue list probing now run inside the same combined bash script as the daily check. Eliminates 3-4 extra tool calls (Read config, Read issue list files, Bash for version) that were visible in the UI between the loading message and results. Users now see only "Checking your PRs across GitHub..." then the summary.
- **Suppressed dashboard generation stdout** - Dashboard command output no longer leaks into the UI.
- **Strengthened git workflow rules in CLAUDE.md** - Emphasized mandatory checkout-main-pull-branch step.
- **Added Code Review section to CLAUDE.md** - Standard review workflow using pr-review-toolkit agents (code-reviewer, silent-failure-hunter, code-simplifier) before pushing.


## [0.25.0] - 2026-02-11

### Added

- **README rewrite** — Restructured to lead with the pain point ("You have 12 open PRs...") instead of product description. Better information architecture: pain → solution → install → usage. Troubleshooting now uses collapsible `<details>` sections. Added tests badge.
- **First-run welcome experience** — When `/oss` detects zero active PRs (new user or clean slate), shows a guided welcome message with options to search for issues, import existing PRs, or explore. Replaces the confusing empty dashboard.
- **Loading screen pattern** — `/oss` command now shows "Checking your PRs across GitHub..." while running all setup, build, and daily check steps in a single combined bash call. Eliminates verbose narration and intermediate tool output. Users see only the loading message, then the results.
- **Issue conversation tracking (#114)** — See [0.33.0] for details (rebased from this branch)

## [0.24.1] - 2026-02-11

### Added

- **CI status badge in README** — Build status badge from GitHub Actions CI workflow now displayed alongside existing badges

## [0.24.0] - 2026-02-11

### Added

- **AI policy detection with configurable repo blocklist** — Repos with known anti-AI contribution policies (e.g., `matplotlib/matplotlib`) are now automatically filtered from search results. Ships with a small default blocklist. Configurable via `setup --set aiPolicyBlocklist="owner/repo,owner2/repo2"`. The issue-scout agent is also trained to detect AI policy signals during manual vetting (hidden comments, policy PRs, anti-AI CONTRIBUTING.md language) and recommend blocklist additions. The `aiPolicyBlocklist` field is exposed in CLI search JSON output. Closes #108.

## [0.23.2] - 2026-02-11

### Fixed

- **Marketplace install failing with "Invalid input"** — `marketplace.json` source field used `"."` which doesn't match the schema's expected relative path format. Changed to `"./"` to match the pattern used by all official Anthropic plugins (e.g., `"./plugins/name"`). Fixes marketplace install via `/plugin marketplace add costajohnt/oss-autopilot`.

## [0.23.1] - 2026-02-11

### Added

- **Marketplace catalog file** — Re-added `.claude-plugin/marketplace.json` (removed in v0.15.1 as unused, but confirmed required by the current marketplace install flow). Users can now install via `/plugin marketplace add costajohnt/oss-autopilot` followed by `/plugin install oss-autopilot@oss-autopilot`. The file is intentionally minimal — version, author, and license are omitted since Claude Code merges these from `plugin.json` at install time.

### Fixed

- Install instructions in README and CLAUDE.md now include the required `@oss-autopilot` marketplace suffix on the `/plugin install` command
- File structure docs in CLAUDE.md now mention `marketplace.json`

## [0.23.0] - 2026-02-10

### Added

- **Parallel multi-strategy issue search** — When searching for new issues, the skill layer now dispatches 3 parallel agents simultaneously: Strategy A checks established repos (merged/open PRs) for new issues, Strategy B runs the CLI filtered search (language + labels + stars), and Strategy C searches trending/popular repos. Results are deduplicated by issue URL, tagged by source, and presented in priority order. One parallel round replaces 3 sequential rounds. Closes #106.
- **Auto-exclude searched repos across rounds** — Session state now tracks `searchedRepos` (repos surfaced in prior rounds). On subsequent search rounds, previously-surfaced repos are automatically passed as exclusions to all 3 strategies. Closes #106.

## [0.22.0] - 2026-02-10

### Added

- **Batch vet workflow for search results** — After search results come back, a new "Add all to list and vet in parallel" option adds candidates to the curated issue list as "Pending vet" entries, dispatches up to 5 parallel issue-scout agents, then updates entries with scores and recommendations. Entries are automatically sorted into priority tiers (Pursue/Maybe/Skip). Closes #107.
- **Diminishing returns detection across search rounds** — Session tracks average vetting score per search round in `searchRoundScores`. When a new round's average drops >30% below the previous, an advisory is shown recommending the user work from their existing list instead of searching more. At >50% drop, the advisory is strengthened. Closes #107.
- **Stronger "work on existing list" nudge** — When `availableCount >= 5`, the issue list option is promoted with ROI-focused language ("starting one would be higher ROI than searching for more") and a brief nudge is displayed before the action menu. Closes #107.

## [0.21.0] - 2026-02-10

### Added

- **Minimum star threshold for Phase 2 search results** — General discovery (Phase 2) now filters out repos with fewer than `minStars` (default 50) GitHub stars. Phases 0 (merged-PR repos) and 1 (starred repos) are exempt since those repos have a known relationship. Repos where the health check failed are not penalized. Configurable via `setup --set minStars=100`. Closes #105.
- **Per-repo result cap (max 2 issues per repo)** — After sorting, no more than 2 issues from any single repo appear in search results. Prevents a single active repo from dominating the candidate list. Applied after priority/recommendation/viability sorting to keep the best candidates. Closes #105.
- **Documentation-only issue filter (opt-in)** — Issues where ALL labels are documentation-related (`documentation`, `docs`, `typo`, `spelling`) can be filtered out via `setup --set includeDocIssues=false`. Included by default since doc issues can have bounties. Issues with mixed labels (e.g., `good first issue` + `documentation`) always pass through. Closes #105.
- `minStars` and `includeDocIssues` fields on `AgentConfig` with defaults (50 and true)
- `isDocOnlyIssue()`, `applyPerRepoCap()`, and `DOC_ONLY_LABELS` exported from issue-discovery module
- 19 new tests for doc-only detection, per-repo capping, and DOC_ONLY_LABELS constant (432 total)

## [0.20.0] - 2026-02-10

### Changed

- **Size-based review agent scaling in Step 5.5** — Pre-commit code review now classifies changes as Small (< 50 lines, ≤ 2 files), Medium (50–200 lines or 3–5 files), or Large (> 200 lines or > 5 files) and dispatches agents accordingly. Small changes get 2 agents (code-reviewer + silent-failure-hunter), Medium adds code-simplifier, Large gets the full suite plus conditional agents. Reduces latency and token cost for typical review-response patches. Step 5.6 (Draft PR Review) always uses the Large tier for new contributions. Closes #90.

### Added

- **Post-response comment step (Standard Path sub-step 7)** — After committing and pushing changes to an existing PR in response to maintainer feedback, the workflow now explicitly drafts a response comment summarizing what was addressed, presents it for user approval, and posts it via `gh pr comment`. Skipped for maintenance-only actions or PRs without maintainer feedback context. Closes #91.

## [0.19.0] - 2026-02-10

### Changed

- **Enriched PR display in /oss workflow** — Step 3 now shows maintainer hints (who commented + what they asked), effort estimates (Small/Medium/Large heuristic), and an explicit priority ordering explanation. Uses data already available on `FetchedPR` — no CLI changes needed. Closes #89.
- **Three-phase "Work through all issues" workflow** — Replaced "Address all N issues in parallel" with a guided sequential flow: Phase A dispatches maintenance in parallel and investigates all Tier 2 items; Phase B presents a consolidated findings table with maintainer ask, effort, and recommended action per PR; Phase C walks through Tier 2 items one-at-a-time with user control after each completion. Closes #88.
- **Renamed action menu item** — "Address all N issues in parallel" → "Work through all N issues" with updated description reflecting the new three-phase approach (parallel maintenance, consolidated findings, sequential code changes).

## [0.18.0] - 2026-02-10

### Added

- **Merged-PR viability bonus** — Issues in repos where the user has merged PRs now receive a +15 viability score bonus, stacking with the existing org affinity (+5) for up to +20 total relationship bonus. This makes proven repos surface higher in search results. Closes #99.
- **Phase 0 open-PR repo expansion** — Phase 0 search now includes repos where the user has interacted (score data exists) but hasn't merged yet. These open-PR repos fill remaining Phase 0 slots after merged-PR repos, capped at 10 total. New `getReposWithOpenPRs()` method on StateManager. Closes #99.
- **Viability score as tertiary sort key** — Within the same priority tier and recommendation level, candidates are now sorted by viability score (highest first), preventing arbitrary ordering among equally-recommended issues. Closes #99.
- **Pre-flight rate limit check** — `searchIssues()` now calls `checkRateLimit()` before starting search phases. When remaining quota < 5, logs a warning with quota info and reset time. The warning is also surfaced in `--json` output via the new `rateLimitWarning` field on `SearchOutput`. Closes #100.
- **`checkRateLimit()` utility** — New exported function in `github.ts` that queries the GitHub Search API rate limit endpoint and returns `{ remaining, limit, resetAt }`. Closes #100.
- **Enhanced rate limit retry logging** — `onRateLimit` and `onSecondaryRateLimit` callbacks now log retry count, wait duration, and reset time (e.g., "Rate limit hit (retry 1/2, waiting 30s, resets at 14:52:00)") instead of bare "Retrying after N seconds...". Closes #100.
- **Graceful partial result context** — When no candidates are found and rate limits were hit during search, the error message now includes "GitHub API rate limits may have affected results" to help users understand the failure. Closes #100.

## [0.17.0] - 2026-02-10

### Changed

- **Label-farming spam filter for issue search** — Phase 2 (general search) now detects and filters label-farming repositories that mass-create beginner-labeled issues. Uses two signals: single issues with 5+ beginner labels (strong signal) and repos with 3+ templated titles like "Add Trivia Question 61" (batch signal). Phases 0/1 (user's own repos) are unaffected. Closes #97.
- **Repo quality bonus in viability scoring** — Issue viability scores now include a quality bonus based on repository star and fork counts. Stars: <50 → +0, 50-499 → +3, 500-4999 → +5, 5000+ → +8. Forks: 50+ → +2, 500+ → +4. This means a 30k-star repo's issues score up to +12 higher than a 10-star spam repo. `ProjectHealth` now includes `stargazersCount` and `forksCount`. Closes #98.

## [0.16.0] - 2026-02-10

### Changed

- **Pre-commit review gate at decision point** — Added a mandatory "Pre-Commit Gate" checkpoint in Step 4 (Execute Approved Actions Only) that routes to Step 5.5 before presenting commit/push options. Previously, the instruction to run pre-commit review was in the Action Tiers preamble, far from the decision point where agents present commit options, causing them to skip it. Now the gate is at the exact point where the agent is about to offer commit options. Closes #86.
- **Conditional daily re-run after actions** — The "After Each Action" section now distinguishes between Tier 1 (rebases, force pushes) and Tier 2 (comment responses, code fixes) actions. Tier 1 triggers a full daily re-run to refresh PR state; Tier 2 skips the re-run since the data is still valid, saving ~10-15s of API calls between sequential PR responses. Closes #87.

## [0.15.1] - 2026-02-10

### Removed

- **Dead code cleanup** — Removed `.claude-plugin/marketplace.json` which was never read during plugin installation. When users run `/plugin marketplace add costajohnt/oss-autopilot`, Claude Code clones the repo and reads `.claude-plugin/plugin.json` directly, never validating marketplace.json. File existed unused since v0.1.0 (33 versions) with no installation issues, confirming it's dead code. Closes #94.

### Fixed

- **README troubleshooting documentation** — Fixed incorrect plugin path in "Build fails on first run" section. Updated from hardcoded `~/.claude/plugins/oss-autopilot` to use `find` command to locate actual installation path, which varies based on installation method (marketplace-installed plugins live in `~/.claude/plugins/cache/`).

## [0.15.0] - 2026-02-10

### Added

- **Issue list parsing command** — New `parse-issue-list <path>` CLI command parses markdown issue lists into structured JSON with tier classification. Handles strikethrough (`~~done~~`), checked checkboxes (`[x]`), "Done" markers, section headings as tiers, and GitHub issue/PR URL extraction. Eliminates fragile AI-side markdown parsing. Closes #82.
- **Integration check command** — New `check-integration --base <branch>` CLI command detects new files added in the current branch that aren't referenced by any other file. Reports referenced-by files for integrated code and suggests entry points for orphaned files. Prevents "dead code" PRs where feature files exist but aren't wired into the build. Closes #83.
- **Local repo detection** — New `local-repos [--scan]` CLI command scans configurable directories for local git clones, caches results in state to avoid repeated filesystem traversal. Maps `owner/repo` remotes to local paths with current branch info. Supports `--paths` override and `--scan` to force refresh. Closes #84.

## [0.14.0] - 2026-02-10

### Added

- **PR display labels in `daily --json`** — Each `FetchedPR` now includes `displayLabel` (e.g., "[CI Failing]") and `displayDescription` (e.g., "2 checks failed: Build, Lint") computed deterministically from status. Eliminates inconsistent label text across sessions where agents would derive labels differently each time. Closes #79.
- **Same-repo PR grouping** — `daily --json` output includes a `repoGroups` field that groups PRs by repository. Prevents parallel git state corruption when multiple PRs exist in the same repo by ensuring one agent per repo during parallel dispatch. Closes #80.
- **CI failure classification** — Each `FetchedPR` now includes `classifiedChecks` alongside `failingCheckNames`, categorizing each failing check as `actionable` (real test/build failure), `fork_limitation` (Vercel, Netlify, Chromatic, etc.), or `auth_gate` (CLA, authorization). Reduces repeated agent reasoning on every PR health check. Closes #81.

## [0.13.1] - 2026-02-09

### Added

- **Pre-computed action menu in `daily --json`** — The CLI now outputs an `actionMenu` field with ready-to-use menu items (`key`, `label`, `description`) and context flags (`hasActionableIssues`, `actionableCount`, `hasCapacity`). The orchestration layer uses these directly in AskUserQuestion instead of manually deriving options from raw data. Closes #78.

## [0.13.0] - 2026-02-09

### Added

- **Integration check for new files (Step 5.6b)** — After the review cycle, a new step detects files that were created but never imported or registered in any entry point. Prevents "dead code" PRs where a feature file exists but isn't wired into the build. Closes #74.
- **Manual testing prompt (Step 5.7b)** — New checkpoint between review and squash that offers to help the user build/run the project locally to verify runtime behavior before finalizing. Automated review catches code patterns but not UI bugs, keyboard shortcuts, or integration issues. Closes #73.
- **Workflow guard against skipping review cycle** — Added CRITICAL guards at Steps 5.5 (0d), 5.8, and Important Rules preventing `gh pr ready` from being called without completing Steps 5.6, 5.6b, 5.7b, and 5.7. Closes #72.

### Changed

- **Review agent prompts include working directory** — All agent dispatch templates in Steps 5.5 and 5.6 now include `Working directory: {local repo path}` so agents search the correct repo instead of inheriting the parent session's CWD. Closes #75.
- **Squash force-push handles stale lease refs** — Step 5.7 (5c) now fetches the branch before `--force-with-lease` to update the local tracking ref. Includes a retry with explicit lease value if the initial push still fails after multiple session pushes. Closes #76.
- **Draft-first workflow flow updated** — Flow summary in Step 4 now reflects the full sequence: 5.5 → 5.6 → 5.6b → 5.7b → 5.7 → 5.8 → 6 → 6.5.

## [0.12.2] - 2026-02-09

### Fixed

- **File permissions not enforced on existing state files** — `writeFileSync({ mode: 0o600 })` only sets permissions when creating a new file; existing files retained their original permissions (typically 644/world-readable). Added explicit `chmodSync(0o600)` after every state and backup write to enforce owner-only access regardless of file age.
- **Data directory created with default permissions** — `~/.oss-autopilot/` and `backups/` directories were created without explicit mode, defaulting to 755 (world-readable listing). Now created with `0o700` (owner-only).
- **Dashboard HTML had no explicit permissions** — Now written with intentional `0o644` mode instead of relying on umask defaults.

### Added

- **Prompt injection defense for agents** — `pr-responder` and `issue-scout` agents now include explicit instructions to treat GitHub-provided content (PR titles, comments, issue bodies) as untrusted input and flag suspicious prompt injection attempts to the user.

## [0.12.1] - 2026-02-09

### Fixed

- **CI failures hidden behind `changes_addressed` status (#68)** — When a PR had addressed maintainer feedback but CI was failing, the status showed `changes_addressed` (informational) instead of `failing_ci` (actionable). CI failures now take precedence over `changes_addressed` since they block maintainer re-review and require contributor action. Priority hierarchy preserved: `needs_response` > `needs_changes` > `failing_ci` > `changes_addressed`.
- **False `needs_response` for acknowledgment comments (#69)** — Simple maintainer acknowledgments ("thanks", "LGTM", "will review soon") no longer trigger `needs_response` status. New `isAcknowledgmentComment()` detection uses conservative heuristics: keyword match + no question mark + under 100 chars. Actionable comments after an acknowledgment still correctly trigger `needs_response`.
- **Spurious "Needs Response" badge in dashboard** — When a PR's status is upgraded from `changes_addressed` to `failing_ci`, the dashboard no longer shows a misleading "Needs Response" badge alongside the CI failure status.

## [0.12.0] - 2026-02-09

### Fixed

- **Security: XSS vulnerability in dashboard HTML** — PR titles, comment bodies, and other user-controlled content from the GitHub API are now HTML-escaped before interpolation into the dashboard. Prevents script injection via malicious PR titles.
- **Concurrency bug in PR fetching** — Replaced fragile `Promise.race` + `splice` concurrency pattern with a worker-pool approach that correctly limits parallel API calls without losing track of in-flight requests.
- **API failure guard for closed PR counts** — Added transient-failure protection to closed PR count updates (matching the existing guard on merged counts) to prevent zeroing scores during GitHub API outages.
- **Top-level error handling in daily command** — `runDaily` now wraps its logic in try/catch so unexpected errors produce a clear message (or structured JSON error) instead of an unhandled rejection.

### Added

- **GitHub issue templates** — Bug report and feature request templates (`.github/ISSUE_TEMPLATE/`) standardize issue reporting
- **Pull request template** — Checklist template (`.github/pull_request_template.md`) ensures PRs include version bumps, changelog, and test results
- **CODE_OF_CONDUCT.md** — Contributor Covenant-based code of conduct
- **SECURITY.md** — Security policy with vulnerability reporting instructions and scope documentation
- **Setup completeness check** — `/oss` now detects incomplete setup (`setupComplete === false`) and offers to run `/setup-oss` before proceeding
- **Build error surfacing** — Auto-build step in `/oss` now captures and displays npm errors instead of silently redirecting to `/dev/null`
- **Example workflows in README** — Daily standup, finding contributions, and responding to feedback workflows help new users understand the tool
- **Additional FAQ entries** — GitLab/Gitea support question, offline usage, expanded troubleshooting

### Changed

- CLI auth error messages now include a link to GitHub CLI installation docs and clearer step-by-step instructions
- README now explicitly states this is a Claude Code plugin (with callout block) and has improved prerequisites formatting
- Removed unused legacy methods (`syncPRs`, `checkAllPRs`) and associated types from `PRMonitor` — reduces maintenance surface without breaking any commands

## [0.11.1] - 2026-02-09

### Changed

- Dashboard visual redesign — darker base (#080b10), ambient radial glows, unified stats bar with colored underlines, uppercase section titles, tighter spacing, 3-color gradient logo
- Dashboard command now fetches merged/closed PR counts directly (previously only `daily` populated monthly chart data), so Contribution Timeline shows all three datasets without needing to run `daily` first
- Timeline and Success Rate charts use contiguous 6-month range from today instead of sparse historical months (fixes 2019→2026 x-axis gap)

## [0.11.0] - 2026-02-09

### Added

- **Contribution Timeline enhancement (#17)** — Replaced single-line merged chart with grouped bar chart showing Opened/Merged/Closed PRs per month. New `monthlyOpenedCounts` and `monthlyClosedCounts` state fields power the three-series view.
- **Repository Breakdown enhancement (#19)** — Repos beyond top 10 are now aggregated into an "Other" bucket. Repos sorted by total PRs (merged + active + closed) instead of merged only. Tooltips show each repo's percentage share of total PRs.
- **Success Rate Trends chart (#21)** — New monthly merge rate line chart showing `merged / (merged + closed) * 100` per month. Months with zero resolved PRs show gaps. Tooltip shows percentage plus raw counts. Y-axis 0-100%.
- **Activity Heatmap (#23)** — New CSS grid calendar heatmap showing 3-month rolling window of contribution activity. GitHub-style green color scale (4 intensity levels) built from open PR creation dates, closed PR dates, and state events. Native title tooltips, no Chart.js dependency.
- `fetchUserMergedPRCounts()` now returns `monthlyOpenedCounts` alongside existing `monthlyCounts`
- `fetchUserClosedPRCounts()` return type enhanced from `Map<string, number>` to `{ repos, monthlyCounts, monthlyOpenedCounts }` — extracts monthly closed and monthly opened histograms from the same API iteration
- `setMonthlyClosedCounts()` and `setMonthlyOpenedCounts()` setter methods on `StateManager`
- `monthlyClosedCounts` and `monthlyOpenedCounts` fields on `AgentState` type
- Combined monthly opened counts in daily orchestration merge data from merged PRs, closed PRs, and currently-open PRs (mutually exclusive GitHub states — no double counting)

## [0.10.1] - 2026-02-09

### Fixed

- Dashboard "Attention Required" section now split into "Action Required" (contributor must act) and "Waiting on Others" (informational). Previously grouped all health issues together, creating false urgency. Closes #62.
- Added missing `needsChangesPRs` rendering to dashboard — PRs with requested changes were not shown in any health section
- Added `waitingOnMaintainerPRs` and `ciNotRunningPRs` rendering blocks — previously counted but never displayed
- Dashboard health issue count now matches rendered items (previously `healthIssues` array diverged from template)

## [0.10.0] - 2026-02-08

### Added

- Draft-first PR workflow for new contributions (Steps 5.6–5.8) — new PRs are created as drafts, reviewed iteratively with scope-aware agents, squashed into a single commit, and only marked ready after explicit user confirmation. Closes #59.
- Scope-aware review agents — review prompts include the issue context so findings stay focused on the PR's purpose, preventing scope creep from pre-existing code issues
- Iterative review cycle with soft 3-round limit — after 3 rounds, gently prompts user to finalize rather than continuing indefinitely
- Squash + reword step (Step 5.7) — squashes all review-cycle commits into a single clean commit with a reworded message reflecting all work done
- Per-repo squash configuration — `squashByDefault` global setting with `repoOverrides.{repo}.squash` for repos that prefer atomic commits
- Mark-ready gate (Step 5.8) — explicit user confirmation required before `gh pr ready` makes the PR visible to maintainers
- `isNewContribution` and `issueContext` session variables for routing new contributions through draft-first flow
- Squash preference question in `/setup-oss` (both CLI and markdown paths)

### Changed

- Step 5.5 now routes differently based on `isNewContribution` — new contributions skip pre-commit review agents (moved to Step 5.6), existing PR updates keep the standard review-before-commit flow
- Step 5.5 sub-step 0 replaced by new routing logic (New Contribution vs Existing PR Update); standard-path sub-steps renumbered from 1–6 (formerly 0–5)
- Step 6 notes that draft-first PRs have already been code-reviewed, so compliance check focuses on PR description quality and opensource.guide standards

## [0.9.0] - 2026-02-08

### Added

- Smarter issue search strategy — new Phase 0 prioritizes repos where user has merged PRs (highest merge probability), replacing the generic "high-score" phase. Phase 0 uses a broader search query without `good first issue`/`help wanted` labels — established contributors can handle any open issue
- `getReposWithMergedPRs()` method on `StateManager` — returns repos sorted by merged PR count for search prioritization
- Logarithmic repo scoring formula — merge bonus now scales from +2 (1 PR) to +5 (5+ PRs), replacing the linear formula. Full formula: base 5, log merge bonus (max +5), -1 per closed (max -3), +1 recency, +1 responsive, -2 hostile, clamped [1-10]
- Recency bonus in repo scoring — +1 for repos with a merge within the last 90 days, so stale relationships decay over time
- Responsiveness signal from open PR data — daily check now observes maintainer behavior (comments, review states) and updates `isResponsive` signal on repo scores
- Active maintainer detection — repos with open PRs in healthy/review states get `hasActiveMaintainers: true` from real data instead of defaults
- Auto-sync `trustedProjects` from merged PR history — repos with mergedPRCount > 0 are automatically added to trustedProjects during daily check
- Org-level affinity scoring — +5 viability bonus for issues in repos under an org where user has merged PRs elsewhere (e.g., merged in `facebook/react` boosts `facebook/react-dom` issues)
- Closed/rejected PR history check in issue vetting — repos where all user PRs were closed without merge get a -15 viability penalty; mixed history shown as informational note
- `searchPriority`, `viabilityScore`, `repoScore`, and `excludedRepos` fields in search JSON output — agents can see why each issue was ranked and which repos were filtered
- Exclusion awareness for issue-scout agent — fallback `gh` searches now respect the exclusion list
- Issue list depletion detection — when curated list reaches 0 available issues, offers "Replenish your issue list" instead of empty state
- Auto-exclude prompt for recently closed PRs — offers to exclude repos where PRs were rejected
- `CheckResult` type for vetting checks that may be inconclusive — `checkNoExistingPR` and `checkNotClaimed` now return `{ passed, inconclusive?, reason? }` instead of bare `boolean`, surfacing API failures to the user
- Aggregate failure detection in daily signal/trust sync loops — `[DAILY_ALL_SIGNAL_UPDATES_FAILED]` and `[DAILY_ALL_TRUST_SYNCS_FAILED]` tags logged when all updates fail, matching the pattern already used in `searchInRepos` and `vetIssuesParallel`
- Per-phase error tracking in `searchIssues` — phases 0, 1, and 2 errors are now all included in the final "No issue candidates found" error message
- 32 new tests (254 total): logarithmic scoring, recency bonus, org affinity, computeRepoSignals, partial signal preservation, closed-PR viability penalty, `markRepoHostile` signal preservation, and `incrementMergedCount`/`incrementClosedCount` routing

### Changed

- Search phases reordered: merged-PR repos → starred repos → general (was: starred → high-score → general)
- `SearchPriority` type: `'merged_pr' | 'starred' | 'normal'` union replacing raw `string`
- `vetIssue()` now uses `repoScores` directly for trusted project detection, showing merge count (e.g., "Trusted project (3 PRs merged)")

### Fixed

- `RepoScoreUpdate` type introduced replacing `Partial<RepoScore>` in `updateRepoScore()` — prevents callers from setting `score`, `repo`, or `lastEvaluatedAt` fields that should never be set externally
- `RepoSignals` interface extracted from inline `RepoScore.signals` type — enables type-safe partial signal updates
- `ComputedRepoSignals` type moved to `src/core/types.ts` so core domain types are defined in the core module, not in command modules
- `incrementMergedCount()` and `incrementClosedCount()` now route through `updateRepoScore()` for a single mutation path — all repo score changes flow through one typed interface with diagnostic log messages
- `vetIssue()` now checks `projectHealth.checkFailed` — repos are no longer penalized as "inactive" when the health check itself failed due to API errors; uses a neutral default instead
- Recommendation downgraded to `needs_review` when any vetting check was inconclusive — `approve` now requires all checks to actually pass, not just optimistically default
- `checkNoExistingPR` and `checkNotClaimed` inconclusive results surfaced as vetting notes — previously silent on API failure, users can now see "Could not verify absence of existing PRs" or "Could not verify claim status"
- `searchInRepos` and `vetIssuesParallel` now return failure metadata (`allBatchesFailed`, `allFailed`) to callers — failures propagate to the final error message instead of being absorbed
- Silent batch-failure absorption in `searchInRepos` — now tracks failed batch count and logs `[SEARCH_PHASE_ALL_BATCHES_FAILED]` when all batches fail
- Silent vetting-failure absorption in `vetIssuesParallel` — now logs `[VET_ISSUES_ALL_FAILED]` when all issues fail vetting
- `computeRepoSignals` now skips PRs with empty/missing `repo` field with a warning, preventing corrupted state entries
- Daily check signal/trusted-project sync loops wrapped in try-catch with aggregate failure detection so a single corrupted repo score cannot crash the entire daily digest
- Misleading org affinity guard `orgName !== repoFullName` replaced with `repoFullName.includes('/')` to clearly express intent
- Hardcoded status comparisons in `computeRepoSignals` replaced with named `Set<FetchedPRStatus>` constants for exhaustiveness tracking

## [0.8.8] - 2026-02-08

### Fixed

- SessionStart hook status not visible to user — `additionalContext` only injects into the AI's system context, never displayed to the user. Added `systemMessage` field to hook JSON output so the PR status summary (e.g., "OSS: 16 active PRs — 2 awaiting re-review") is shown as a visible notification on session start.

## [0.8.7] - 2026-02-08

### Fixed

- SessionStart health check was silent even with active PRs — only reported when `totalNeedingAttention > 0`, which excluded `changesAddressedPRs` and `waitingOnMaintainerPRs`. Now always shows a one-liner summary with PR portfolio breakdown (e.g., "OSS: 16 active PRs — 2 awaiting re-review, 1 waiting on maintainer").

## [0.8.6] - 2026-02-08

### Fixed

- SessionStart hook not executing startup checks — was using markdown-based format (`.claude-plugin/hooks/SessionStart.md`) which injects text but never runs bash. Replaced with command-based `hooks/hooks.json` pointing to `hooks/session-start.sh`, matching the pattern used by working plugins (`explanatory-output-style`, `superpowers`). Bundle rebuild, update check, and PR health notifications now actually execute on session start.
- Update check crashing on repos with no GitHub releases — API 404 response was passed through as a "version", now validates response matches semver format before comparing.

## [0.8.5] - 2026-02-08

### Added

- Comprehensive JSDoc documentation for all exported symbols in `src/core/types.ts`, `src/core/state.ts`, and `src/core/utils.ts`
- `@param`, `@returns`, `@example`, and `@throws` tags on all exported functions
- Property-level descriptions on interfaces where purpose isn't obvious from name
- Cross-references between related types (e.g., `TrackedPR` ↔ `FetchedPR`, v1 vs v2 architecture)
- Documented scoring formula, event cap behavior, caching semantics, and v2 architecture decisions

## [0.8.4] - 2026-02-08

### Added

- Unit tests for `utils.ts` — `parseGitHubUrl`, `daysBetween`, `splitRepo`, `formatRelativeTime`, `byDateDescending` (35 tests)
- Unit tests for `issue-discovery.ts` — `calculateViabilityScore` and `analyzeRequirements` (20 tests)
- Expanded `pr-monitor.ts` test coverage — `determineStatus` all paths, `analyzeChecklist`, `extractMaintainerActionHints`, `determineReviewDecision`, `getLatestChangesRequestedDate`, `hasMergeConflict`, `checkUnrespondedComments` (48 new tests)
- Test count: 68 → 171 (2.5x increase)

### Fixed

- Redundant `if (!options.json)` guard in `comments.ts` (unreachable after early return). Closes #20 (items a, b)
- Redundant `success: true` in `outputJson()` data payloads in `runPost` and `runClaim` — `outputJson` already wraps in success envelope

## [0.8.3] - 2026-02-08

### Fixed

- PRs with `changes_requested` review decision but no new commits incorrectly classified as 'healthy' — added `needs_changes` status that detects when a maintainer requests changes via inline review comments (empty review body) and the contributor hasn't pushed new commits yet. Also adds `changes_addressed` detection when commits are pushed after the review. Fixes #48.

## [0.8.2] - 2026-02-08

### Fixed

- SessionStart health check script not found — path was `${CLAUDE_PLUGIN_ROOT}/scripts/` but the file lives at `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/scripts/`

## [0.8.1] - 2026-02-08

### Fixed

- SessionStart health check silently failing on Node.js 24 — `node -e` inline scripts break because the Bash tool escapes `!` to `\!`, which is invalid in Node 24's TypeScript parser. Moved health check logic to a `.cjs` script file that works on Node 18 through 24+.

## [0.8.0] - 2026-02-08

### Added

- Proactive PR health check notification on session start — reads cached state to show "2 of 15 PRs need attention" without any network calls; configurable via `showHealthCheck` setting
- "Why OSS Autopilot?" competitive comparison section in README

## [0.7.2] - 2026-02-08

### Fixed

- Stale `needs_response` status when contributor has already pushed changes addressing maintainer feedback
  - GitHub's `reviewDecision` stays `changes_requested` until maintainer re-approves, causing false positives
  - Now compares latest commit timestamp against last maintainer comment — if the commit is newer, shows `changes_addressed` instead of `needs_response`
  - New `changes_addressed` status shown in daily digest, dashboard, and JSON output
  - Not counted in `totalNeedingAttention` (not actionable by contributor)

## [0.7.1] - 2026-02-08

### Removed

- Deleted `src/index.ts` — 1,172 lines of dead code from the pre-Commander monolith
- Removed `dotenv` dependency — token detection uses `gh auth token` / `$GITHUB_TOKEN`, not `.env` files

### Fixed

- `package.json` `main` field pointed to non-existent `dist/index.js`, now points to `dist/cli.js`
- State file now written with `0600` permissions (owner-only read/write) for security
- Events array capped at 1,000 entries to prevent unbounded state file growth
- Replaced `any` types in `issue-discovery.ts` with proper `GitHubSearchItem` interface

## [0.7.0] - 2026-02-08

### Added

- Pre-commit hooks enforcing workflow rules from CLAUDE.md:
  - **Version sync check** — blocks commits when `package.json`, `plugin.json`, and README badge versions don't match
  - **No AI attribution** — blocks commits containing "Co-Authored-By: Claude" or similar attribution
  - **No commits on main** — blocks direct commits to `main`/`master` branch
  - **Conventional commit format** — blocks messages without `feat:`, `fix:`, `chore:` etc. prefix

### Fixed

- README version badge stuck at 0.4.1 while actual version was 0.6.1
- CLAUDE.md versioning checklist missing README badge as a required update location

## [0.6.1] - 2026-02-08

### Added

- SessionStart hook for automatic stale bundle rebuild after plugin updates
- Daily update notification — shows when a newer version is available on GitHub
- Version display in `/oss` summary output (e.g., "v0.6.1")

### Fixed

- CLI bundle not rebuilt after `/plugin update` — Step 0.5 only checked file existence, not staleness
- CLI VERSION constant hardcoded at 0.1.0 — now reads from package.json at runtime

## [0.6.0] - 2026-02-08

### Added

- Pre-commit code review step (Step 5.5) in `/oss` workflow — comprehensive quality gate before committing
- New `pre-commit-reviewer` agent for standalone code review
- Parallel dispatch of PR review toolkit agents (code-reviewer, silent-failure-hunter, code-simplifier, pr-test-analyzer) for thorough analysis
- Target repository convention checking (CONTRIBUTING.md, lint configs, test patterns)
- Fix-review-commit loop: address findings, re-review until clean, then commit (with optional manual diff review)
- Conditional dispatch of type-design-analyzer and comment-analyzer for relevant changes
- Fallback to local pre-commit-reviewer agent when PR review toolkit is unavailable

## [0.5.0] - 2026-02-08

### Added

- Track closed PRs from GitHub — queries `is:pr is:closed is:unmerged` to populate `closedWithoutMergeCount` in repo scores
- Recently closed PRs section in daily digest and dashboard — surfaces PRs closed without merge in the last 7 days
- `fetchUserClosedPRCounts()` and `fetchRecentlyClosedPRs()` methods in PRMonitor
- `ClosedPR` type and `recentlyClosedPRs` field in `DailyDigest`
- `recently_closed` actionable issue type for structured output

### Fixed

- Merge rate was always 100% because `closedWithoutMergeCount` was never populated from GitHub
- Closed PRs were invisible — a PR closed by a maintainer would silently vanish from the dashboard

## [0.4.1] - 2026-02-07

### Fixed

- Deduplicate CI check runs by name to prevent superseded failures from incorrectly flagging PRs
  - GitHub's `checks.listForRef` returns all historical runs including re-runs
  - Now keeps only the most recent run per unique check name
  - Fixes false "CI Failing" status when a check is re-run and passes

### Added

- Tests for CI status deduplication logic in `pr-monitor.test.ts`

## [0.4.0] - 2025-02-07

### Added

- Curated issue list integration and post-PR flow continuity
- CHANGELOG.md with reconstructed version history
- Version badge and new README sections: Updating, Troubleshooting, FAQ
- Release process documentation in CONTRIBUTING.md

### Changed

- Synced version across `plugin.json` and `package.json` (both now `0.4.0`)
- README overhaul with improved structure and new user-facing sections

## [0.3.0] - 2025-01-27

### Added

- v2 fresh GitHub fetching architecture — replaces cached state with live GitHub API calls (#27)
- Merged PR counts populated from GitHub with org/owner filtering (#29)
- Rebase detection, action tiers, and new PR status categories in daily check (#30)
- Checklist detection, action hints, and waiting-on-maintainer status (#33)
- Bundled CLI with esbuild for zero-install experience (#34)

### Fixed

- Filter non-actionable CI statuses from capacity assessment (#32)

## [0.2.0] - 2025-01-25

### Added

- Hybrid CLI architecture with action-first UX and human-in-the-loop (#5)
- Plugin marketplace support for `/plugin discovery` (#9)
- CONTRIBUTING.md for new contributors (#16)
- Social preview image

### Changed

- README rewritten to lead with discovery, add adaptive features (#11)
- README cleaned up, linked to CONTRIBUTING.md (#25)

## [0.1.0] - 2025-01-06

### Added

- Initial release of OSS Autopilot
- Interactive features: comment posting, dashboard
- Project guidelines and AI attribution rules
- `/oss` and `/setup-oss` slash commands
- Specialized agents: pr-responder, pr-health-checker, issue-scout, repo-evaluator, contribution-strategist
- TypeScript CLI backend with structured JSON output
- PR monitoring and health checking
- Dashboard HTML generation

[0.35.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.34.1...v0.35.0
[0.34.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.34.0...v0.34.1
[0.34.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.33.1...v0.34.0
[0.33.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.30.1...v0.31.0
[0.30.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.30.0...v0.30.1
[0.30.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.7...v0.27.0
[0.26.7]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.6...v0.26.7
[0.26.6]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.5...v0.26.6
[0.26.5]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.4...v0.26.5
[0.26.4]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.3...v0.26.4
[0.26.3]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.2...v0.26.3
[0.26.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.23.2...v0.24.0
[0.23.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.8...v0.9.0
[0.8.8]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.7...v0.8.8
[0.8.7]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/costajohnt/oss-autopilot/releases/tag/v0.1.0
