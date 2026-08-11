# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.20.5](https://github.com/costajohnt/oss-autopilot/compare/core-v3.20.4...core-v3.20.5) (2026-08-11)


### Bug Fixes

* stop counting URL-bearing sub-bullets and prose paragraphs as available issues ([#1620](https://github.com/costajohnt/oss-autopilot/issues/1620)) ([f54c42d](https://github.com/costajohnt/oss-autopilot/commit/f54c42ddfe5b82ca1e706ff75a9a627f67b02357))

## [3.20.4](https://github.com/costajohnt/oss-autopilot/compare/core-v3.20.3...core-v3.20.4) (2026-08-08)


### Bug Fixes

* **build:** build core types before bundling so root bundle works standalone ([#1615](https://github.com/costajohnt/oss-autopilot/issues/1615)) ([cdab13a](https://github.com/costajohnt/oss-autopilot/commit/cdab13a39e743e2a0c211d90a64261a95c2ecc8a))
* **deps:** pin fixed versions of vulnerable transitive dependencies ([#1617](https://github.com/costajohnt/oss-autopilot/issues/1617)) ([23d9f6e](https://github.com/costajohnt/oss-autopilot/commit/23d9f6e2e3c916a36ab6728bc09105028f5c4f73))

## [3.20.3](https://github.com/costajohnt/oss-autopilot/compare/core-v3.20.2...core-v3.20.3) (2026-08-08)


### Bug Fixes

* bound recent PR fetches on updated, not closed/merged ([#1585](https://github.com/costajohnt/oss-autopilot/issues/1585)) ([7abdc00](https://github.com/costajohnt/oss-autopilot/commit/7abdc00f473ec249b6f925a8fa79c9cd5a11b657))
* **test:** give startup e2e tests headroom over the subprocess timeout ([#1613](https://github.com/costajohnt/oss-autopilot/issues/1613)) ([0e6069c](https://github.com/costajohnt/oss-autopilot/commit/0e6069c10685b3f000501b3d309e3333d5ae6e8b))

## [3.20.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.20.1...core-v3.20.2) (2026-08-08)


### Bug Fixes

* **deps:** bump @oss-scout/core to ^1.5.2 ([#1612](https://github.com/costajohnt/oss-autopilot/issues/1612)) ([5a5f418](https://github.com/costajohnt/oss-autopilot/commit/5a5f4188924bddfd24688b8a5d11cd8b7d308d9f))

## [3.20.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.20.0...core-v3.20.1) (2026-08-06)


### Bug Fixes

* drop empty updatedInput from hook permission payloads ([#1607](https://github.com/costajohnt/oss-autopilot/issues/1607)) ([9074f11](https://github.com/costajohnt/oss-autopilot/commit/9074f11c6bf58c6813406df7fad37f47d09a79b1))
* read hook config from the gist mirror when it is newer ([#1605](https://github.com/costajohnt/oss-autopilot/issues/1605)) ([b9b1d39](https://github.com/costajohnt/oss-autopilot/commit/b9b1d39fd3957038c58281d522f3147b0b7123e2))

## [3.20.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.19.3...core-v3.20.0) (2026-08-05)


### Features

* opt-in own-repo trust for the public-post guard ([#1603](https://github.com/costajohnt/oss-autopilot/issues/1603)) ([c5aa504](https://github.com/costajohnt/oss-autopilot/commit/c5aa504209193686a09af3af898d889a0e4f9aec))

## [3.19.3](https://github.com/costajohnt/oss-autopilot/compare/core-v3.19.2...core-v3.19.3) (2026-07-30)


### Bug Fixes

* **deps:** unblock Dependabot updates; test(core): start cli-registry coverage ratchet ([#1588](https://github.com/costajohnt/oss-autopilot/issues/1588)) ([ad14b9f](https://github.com/costajohnt/oss-autopilot/commit/ad14b9f5d7943c8bb8a399af48acbd4ad3ec674b))
* **hooks:** add missing hookEventName so guard decisions take effect ([#1595](https://github.com/costajohnt/oss-autopilot/issues/1595)) ([0f590db](https://github.com/costajohnt/oss-autopilot/commit/0f590db506668b50b35402085303140810417ac5))

## [3.19.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.19.1...core-v3.19.2) (2026-07-22)


### Bug Fixes

* **startup:** resolve and persist absolute issue-list and skip paths ([#1583](https://github.com/costajohnt/oss-autopilot/issues/1583)) ([04035ee](https://github.com/costajohnt/oss-autopilot/commit/04035ee160b9a1b84da9c1ed6dc1d123db1d2d39))

## [3.19.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.19.0...core-v3.19.1) (2026-07-21)


### Bug Fixes

* **grading:** grade new repos on intrinsic merge rate; reconcile approve with grade ([#1579](https://github.com/costajohnt/oss-autopilot/issues/1579)) ([682b002](https://github.com/costajohnt/oss-autopilot/commit/682b002057dbe5a8804b427eb1b7307fac6153b4))

## [3.19.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.18.0...core-v3.19.0) (2026-07-15)


### Features

* **pr-ready:** add over-engineering audit layer to the review loop ([#1565](https://github.com/costajohnt/oss-autopilot/issues/1565)) ([eddb03a](https://github.com/costajohnt/oss-autopilot/commit/eddb03a088725d65beada075e7c72868fe66a71c))


### Bug Fixes

* raise bare search default from 5 to 15 so broad/maintained phases can run ([#1572](https://github.com/costajohnt/oss-autopilot/issues/1572)) ([4962160](https://github.com/costajohnt/oss-autopilot/commit/496216057da8ea043c4953d50592cadb47c40c76))

## [3.18.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.17.3...core-v3.18.0) (2026-07-07)


### Features

* **search:** add --strategy flag to select scout discovery phases ([#1561](https://github.com/costajohnt/oss-autopilot/issues/1561)) ([3182e51](https://github.com/costajohnt/oss-autopilot/commit/3182e513569659c120fa3b246bb811586269abe0))

## [3.17.3](https://github.com/costajohnt/oss-autopilot/compare/core-v3.17.2...core-v3.17.3) (2026-07-07)


### Bug Fixes

* **core:** supply searchRotation in buildScoutState for scout 1.4.0 ([#1559](https://github.com/costajohnt/oss-autopilot/issues/1559)) ([7d67d3c](https://github.com/costajohnt/oss-autopilot/commit/7d67d3cd0a77db6a0da45bbf031db5d0ece2b60a))

## [3.17.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.17.1...core-v3.17.2) (2026-07-07)


### Bug Fixes

* **core:** keep the bundled @oss-scout/core fresh within its semver range ([#1557](https://github.com/costajohnt/oss-autopilot/issues/1557)) ([c01de89](https://github.com/costajohnt/oss-autopilot/commit/c01de89b48b5af47b0cc2e11ae728d5a23479eac))

## [3.17.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.17.0...core-v3.17.1) (2026-07-06)


### Bug Fixes

* **hooks:** resolve git target dir so worktree commits aren't misjudged by branch guards ([#1555](https://github.com/costajohnt/oss-autopilot/issues/1555)) ([7c7335c](https://github.com/costajohnt/oss-autopilot/commit/7c7335c63c0dcbd912e95ae4fd468be9005b30f9))
* **status:** don't flag approved+passing PRs with a later approval comment as needs_response ([#1507](https://github.com/costajohnt/oss-autopilot/issues/1507)) ([#1523](https://github.com/costajohnt/oss-autopilot/issues/1523)) ([c8991cd](https://github.com/costajohnt/oss-autopilot/commit/c8991cdfb349210b1f5b55ac10520401f2ab59b5))

## [3.17.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.16.1...core-v3.17.0) (2026-07-06)


### Features

* **monitor:** batch per-PR enrichment via GraphQL to cut daily REST usage ~6x ([#1551](https://github.com/costajohnt/oss-autopilot/issues/1551)) ([5df1ec2](https://github.com/costajohnt/oss-autopilot/commit/5df1ec27c41eeed7b8af3f17157ddf300a34b3f1))


### Bug Fixes

* **github:** retry transient 5xx/network errors via @octokit/plugin-retry ([#1553](https://github.com/costajohnt/oss-autopilot/issues/1553)) ([75ce78c](https://github.com/costajohnt/oss-autopilot/commit/75ce78ce88a900777e36807bea33f33b2835372b))


### Performance Improvements

* **daily:** use ETag conditional requests for commented-issue comment fetches ([#1550](https://github.com/costajohnt/oss-autopilot/issues/1550)) ([6d85638](https://github.com/costajohnt/oss-autopilot/commit/6d85638db7e9d963ac54dbf0674bce16c3a895c2))

## [3.16.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.16.0...core-v3.16.1) (2026-07-04)


### Bug Fixes

* **setup:** make skipBroadWhenSufficientResults and two other keys settable ([#1548](https://github.com/costajohnt/oss-autopilot/issues/1548)) ([9d01791](https://github.com/costajohnt/oss-autopilot/commit/9d0179145a9610e73f11070189d258b15a1e83c2))

## [3.16.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.15.2...core-v3.16.0) (2026-07-01)


### Features

* **search:** run broad discovery for affinity-heavy users; expose skipBroadWhenSufficientResults ([#1539](https://github.com/costajohnt/oss-autopilot/issues/1539)) ([b460123](https://github.com/costajohnt/oss-autopilot/commit/b460123f11eac9efd1a65233ef058b173199b91e))

## [3.15.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.15.1...core-v3.15.2) (2026-06-29)


### Bug Fixes

* **deps:** bump @oss-scout/core to ^1.2.3 for the linked-PR quality gate ([#1537](https://github.com/costajohnt/oss-autopilot/issues/1537)) ([3b4723c](https://github.com/costajohnt/oss-autopilot/commit/3b4723c104e9b52311b7e443c6167588722b272c))

## [3.15.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.15.0...core-v3.15.1) (2026-06-29)


### Bug Fixes

* **commands:** rebuild stale CLI bundle before standalone bundle calls ([#1535](https://github.com/costajohnt/oss-autopilot/issues/1535)) ([ff0d1b5](https://github.com/costajohnt/oss-autopilot/commit/ff0d1b53924e32998ebdc503faf99e6a8070096e))

## [3.15.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.5...core-v3.15.0) (2026-06-28)


### Features

* **grading:** replace A/B/C/F success grade with a 1-10 score ([#1529](https://github.com/costajohnt/oss-autopilot/issues/1529)) ([c96d034](https://github.com/costajohnt/oss-autopilot/commit/c96d0347658bf60b477d7678b8cf43ffc85af173))
* **scout:** persist a search seen-set so result rotation survives across runs ([#1528](https://github.com/costajohnt/oss-autopilot/issues/1528)) ([#1532](https://github.com/costajohnt/oss-autopilot/issues/1532)) ([a757b6a](https://github.com/costajohnt/oss-autopilot/commit/a757b6af7e5b8f9df3a94d89eb6628a7e5783002))


### Bug Fixes

* **deps:** bump @oss-scout/core to ^1.2.2 to pick up search result rotation ([#1534](https://github.com/costajohnt/oss-autopilot/issues/1534)) ([42a7ac7](https://github.com/costajohnt/oss-autopilot/commit/42a7ac7c606593f68faf21d89007c53166b54031))
* **scout:** surface a missing skip file instead of silently searching with an empty skip list ([#1528](https://github.com/costajohnt/oss-autopilot/issues/1528)) ([#1530](https://github.com/costajohnt/oss-autopilot/issues/1530)) ([91b16e3](https://github.com/costajohnt/oss-autopilot/commit/91b16e3f5ef296741c99247629d21e5bf2dc01c8))

## [3.14.5](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.4...core-v3.14.5) (2026-06-21)


### Bug Fixes

* **search:** populate starred-repo cache so scout's starred phase fires ([#1524](https://github.com/costajohnt/oss-autopilot/issues/1524)) ([37d66b1](https://github.com/costajohnt/oss-autopilot/commit/37d66b164fc966a94beaab5964568cf4f90e5a50))

## [3.14.4](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.3...core-v3.14.4) (2026-06-20)


### Bug Fixes

* **gist:** clear gistDegraded on recovery and pass through rate-limit re-read failures ([#1519](https://github.com/costajohnt/oss-autopilot/issues/1519)) ([be7256c](https://github.com/costajohnt/oss-autopilot/commit/be7256c2b1cea8b2c6060766f6ca361b432637bb))

## [3.14.3](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.2...core-v3.14.3) (2026-06-20)


### Bug Fixes

* **gist:** stop sending unsupported If-Match header on Gist PATCH ([#1510](https://github.com/costajohnt/oss-autopilot/issues/1510)) ([#1518](https://github.com/costajohnt/oss-autopilot/issues/1518)) ([fc51ae8](https://github.com/costajohnt/oss-autopilot/commit/fc51ae84fbfd1301af04b58af5f9fd25214d3320))
* **test:** stop nightly e2e from failing on GitHub secondary rate limits ([#1514](https://github.com/costajohnt/oss-autopilot/issues/1514)) ([fb454b8](https://github.com/costajohnt/oss-autopilot/commit/fb454b8d35fb5faec8ce3395cec931a0da349328))

## [3.14.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.1...core-v3.14.2) (2026-06-19)


### Bug Fixes

* parse skip-file lines with trailing inline comments ([#1511](https://github.com/costajohnt/oss-autopilot/issues/1511)) ([9919c29](https://github.com/costajohnt/oss-autopilot/commit/9919c29543a963cd70e92d85bf03ee3bda5de2d5))

## [3.14.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.14.0...core-v3.14.1) (2026-06-16)


### Features

* **vet-list:** consolidate availability verdicts onto the deterministic verify-issue classifier ([#1494](https://github.com/costajohnt/oss-autopilot/issues/1494)) ([#1500](https://github.com/costajohnt/oss-autopilot/issues/1500)) ([96c2ba2](https://github.com/costajohnt/oss-autopilot/commit/96c2ba298471650f5f0c157f676b978d7712c603))


### Bug Fixes

* **dashboard:** carry staleness headers on POST mutator responses ([#1487](https://github.com/costajohnt/oss-autopilot/issues/1487)) ([#1501](https://github.com/costajohnt/oss-autopilot/issues/1501)) ([510d556](https://github.com/costajohnt/oss-autopilot/commit/510d556e0bcbf8bb0143b0f1aad411cf53e82042))
* **dashboard:** self-heal the merged-PR ledger when stranded behind a watermark ([#1504](https://github.com/costajohnt/oss-autopilot/issues/1504)) ([#1505](https://github.com/costajohnt/oss-autopilot/issues/1505)) ([49e792c](https://github.com/costajohnt/oss-autopilot/commit/49e792ce0cac868459aa9bcf79c794543011f2fc))
* **deps:** override hono to &gt;=4.12.25 to clear the high CORS advisory ([#1506](https://github.com/costajohnt/oss-autopilot/issues/1506)) ([1365591](https://github.com/costajohnt/oss-autopilot/commit/1365591f1030415e1ef057c6de5a9e67f3634481))

## [3.14.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.13.4...core-v3.14.0) (2026-06-16)


### Features

* **config:** surface avoidRepos and boostIssueTypes; thread bias into features ([#1464](https://github.com/costajohnt/oss-autopilot/issues/1464)) ([#1489](https://github.com/costajohnt/oss-autopilot/issues/1489)) ([723792b](https://github.com/costajohnt/oss-autopilot/commit/723792b9404ce9cd3792e209f527ebd20db20f7b))
* **daily:** close the merge loop — auto mark-done list entries + extract-learnings nudge ([#1463](https://github.com/costajohnt/oss-autopilot/issues/1463)) ([#1495](https://github.com/costajohnt/oss-autopilot/issues/1495)) ([b31b2fb](https://github.com/costajohnt/oss-autopilot/commit/b31b2fbf8ea1d15f0a66dfcb507567397d4889d4))
* **daily:** follow_up action-menu item for stuck-CI and dormant PRs ([#1462](https://github.com/costajohnt/oss-autopilot/issues/1462)) ([#1484](https://github.com/costajohnt/oss-autopilot/issues/1484)) ([9761958](https://github.com/costajohnt/oss-autopilot/commit/97619581c20f313c87dbf8ec7f16c8cc3df1d42b))
* **repo-vet:** name both repo scores; merge the scoring docs ([#1465](https://github.com/costajohnt/oss-autopilot/issues/1465)) ([#1482](https://github.com/costajohnt/oss-autopilot/issues/1482)) ([f52ad4d](https://github.com/costajohnt/oss-autopilot/commit/f52ad4d9114385fbb08d0f4c241357227d4f669b))
* **state:** persist openedAt and firstMaintainerResponseAt on the PR outcome ledger ([#1461](https://github.com/costajohnt/oss-autopilot/issues/1461)) ([#1488](https://github.com/costajohnt/oss-autopilot/issues/1488)) ([8833671](https://github.com/costajohnt/oss-autopilot/commit/8833671e045d883d7627db957adfea8a9899663f))


### Bug Fixes

* **cli:** match curated-list URLs on a digit boundary shared by both list commands ([#1442](https://github.com/costajohnt/oss-autopilot/issues/1442)) ([#1468](https://github.com/costajohnt/oss-autopilot/issues/1468)) ([8b2dbe0](https://github.com/costajohnt/oss-autopilot/commit/8b2dbe0e42032a568d695fbdf9ec1af6e648daeb))
* **core:** checkpoint config/setup/init mutations to the Gist ([#1440](https://github.com/costajohnt/oss-autopilot/issues/1440)) ([#1472](https://github.com/costajohnt/oss-autopilot/issues/1472)) ([d6f3cab](https://github.com/costajohnt/oss-autopilot/commit/d6f3cab307eccdb73a8896f6c42ba95bb09fb67c))
* **core:** pagination truncation signal, case-insensitive own-filter, digest guards ([#1456](https://github.com/costajohnt/oss-autopilot/issues/1456)) ([#1483](https://github.com/costajohnt/oss-autopilot/issues/1483)) ([176503c](https://github.com/costajohnt/oss-autopilot/commit/176503ce93c19371b302251062c8ed4f5a80d1d7))
* **core:** surface remaining stderr-only failures in --json envelopes ([#1448](https://github.com/costajohnt/oss-autopilot/issues/1448)) ([#1479](https://github.com/costajohnt/oss-autopilot/issues/1479)) ([87e8985](https://github.com/costajohnt/oss-autopilot/commit/87e89856f503c148e1e82252d5d848eeafbf75d8))
* **daily:** persist the raw-status digest; overrides stay a view-layer concern ([#1445](https://github.com/costajohnt/oss-autopilot/issues/1445)) ([#1473](https://github.com/costajohnt/oss-autopilot/issues/1473)) ([65ab28f](https://github.com/costajohnt/oss-autopilot/commit/65ab28f7fa7e1a755cbd842c8cc4a0f3fce503f7))
* **dashboard:** end-to-end staleness and error visibility ([#1446](https://github.com/costajohnt/oss-autopilot/issues/1446)) ([#1485](https://github.com/costajohnt/oss-autopilot/issues/1485)) ([6ed85c1](https://github.com/costajohnt/oss-autopilot/commit/6ed85c12918931380fe50957a1920d42504fec97))
* **dashboard:** surface persistence failures in partialFailures ([#1447](https://github.com/costajohnt/oss-autopilot/issues/1447)) ([#1475](https://github.com/costajohnt/oss-autopilot/issues/1475)) ([afdcd78](https://github.com/costajohnt/oss-autopilot/commit/afdcd78debc7ce5afc621330136b3d8b8f49a231))
* **mcp:** reload state per tool call and keep repair tools usable on hard gist-init errors ([#1439](https://github.com/costajohnt/oss-autopilot/issues/1439), [#1441](https://github.com/costajohnt/oss-autopilot/issues/1441)) ([#1471](https://github.com/costajohnt/oss-autopilot/issues/1471)) ([4820fc2](https://github.com/costajohnt/oss-autopilot/commit/4820fc2ff98ca55ff2fa9c4cb4e8c5b8cb76465e))
* **security:** fence titles on MCP surfaces; label guidelines provenance; pin the posts-guard matcher ([#1455](https://github.com/costajohnt/oss-autopilot/issues/1455)) ([#1493](https://github.com/costajohnt/oss-autopilot/issues/1493)) ([a4bb7d4](https://github.com/costajohnt/oss-autopilot/commit/a4bb7d493cb78013fe1269093f21f2e3e3e4823d))
* **state:** keep the migrating machine in gist mode after state.json is renamed away ([#1438](https://github.com/costajohnt/oss-autopilot/issues/1438)) ([#1467](https://github.com/costajohnt/oss-autopilot/issues/1467)) ([19e1f31](https://github.com/costajohnt/oss-autopilot/commit/19e1f317726d7666be40d640ea9660592eeeb7bd))
* **state:** report and recover the gist-degraded bootstrap honestly ([#1443](https://github.com/costajohnt/oss-autopilot/issues/1443)) ([#1492](https://github.com/costajohnt/oss-autopilot/issues/1492)) ([c43b2c5](https://github.com/costajohnt/oss-autopilot/commit/c43b2c59ffbf3b1cfb9656a9ffff16fd7b354073))

## [3.13.4](https://github.com/costajohnt/oss-autopilot/compare/core-v3.13.3...core-v3.13.4) (2026-06-12)


### Bug Fixes

* **core:** dashboard gist recovery lifecycle + gist warning in CLI JSON envelopes ([#1436](https://github.com/costajohnt/oss-autopilot/issues/1436)) ([60c2d29](https://github.com/costajohnt/oss-autopilot/commit/60c2d290217853a7c412b51056d4135340e56f00)), closes [#1433](https://github.com/costajohnt/oss-autopilot/issues/1433)

## [3.13.3](https://github.com/costajohnt/oss-autopilot/compare/core-v3.13.2...core-v3.13.3) (2026-06-12)


### Bug Fixes

* **core,mcp:** close gist-degradation gaps outside the MCP tool path ([#1434](https://github.com/costajohnt/oss-autopilot/issues/1434)) ([d8dff08](https://github.com/costajohnt/oss-autopilot/commit/d8dff08a5de15c0cc8fc91d090a03aa925f0ecdb)), closes [#1431](https://github.com/costajohnt/oss-autopilot/issues/1431)

## [3.13.2](https://github.com/costajohnt/oss-autopilot/compare/core-v3.13.1...core-v3.13.2) (2026-06-12)


### Bug Fixes

* **core,mcp:** transient gist-init failures retry instead of silently latching local-only ([#1430](https://github.com/costajohnt/oss-autopilot/issues/1430)) ([9e6c5c9](https://github.com/costajohnt/oss-autopilot/commit/9e6c5c98785fe4d103abd12c4a97bd6b3e2de6af)), closes [#1415](https://github.com/costajohnt/oss-autopilot/issues/1415)

## [3.13.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.13.0...core-v3.13.1) (2026-06-12)


### Bug Fixes

* **core:** dashboard mutations surface and retry failed Gist checkpoints ([#1426](https://github.com/costajohnt/oss-autopilot/issues/1426)) ([4b7dc3f](https://github.com/costajohnt/oss-autopilot/commit/4b7dc3ffe9aef7aa8d0c6cc91f1e7af52d7bc482)), closes [#1417](https://github.com/costajohnt/oss-autopilot/issues/1417)
* **core:** dashboard partitions on post-override status, matching the CLI ([#1424](https://github.com/costajohnt/oss-autopilot/issues/1424)) ([e720ec4](https://github.com/costajohnt/oss-autopilot/commit/e720ec48d35864ba81690f8174d9e09f1a10644b)), closes [#1416](https://github.com/costajohnt/oss-autopilot/issues/1416)
* **core:** pin contract goldens to their output schemas and typecheck tests ([#1422](https://github.com/costajohnt/oss-autopilot/issues/1422)) ([d6ac828](https://github.com/costajohnt/oss-autopilot/commit/d6ac8285f2130fa42b7c529d0d7ed2fe37d1bcb9)), closes [#1418](https://github.com/costajohnt/oss-autopilot/issues/1418)
* **security:** fence lastMaintainerComment.body at agent-facing boundaries ([#1427](https://github.com/costajohnt/oss-autopilot/issues/1427)) ([6707ecf](https://github.com/costajohnt/oss-autopilot/commit/6707ecf046ae1e347ca3b857fcaf9223e76a37b5)), closes [#1420](https://github.com/costajohnt/oss-autopilot/issues/1420)

## [3.13.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.12.0...core-v3.13.0) (2026-06-11)


### Features

* **core:** diversity counterweight + surfaced bias annotations for strategy-biased search ([#1244](https://github.com/costajohnt/oss-autopilot/issues/1244)) ([#1413](https://github.com/costajohnt/oss-autopilot/issues/1413)) ([7a0d10f](https://github.com/costajohnt/oss-autopilot/commit/7a0d10fcc2300d1f65a75b90b87528fedf7a8635))


### Bug Fixes

* **core:** list-mark-done errors on URL not found instead of quiet success ([#1406](https://github.com/costajohnt/oss-autopilot/issues/1406)) ([#1411](https://github.com/costajohnt/oss-autopilot/issues/1411)) ([d892676](https://github.com/costajohnt/oss-autopilot/commit/d892676da0da445c824ddac7311551f074838f7e))

## [3.12.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.11.0...core-v3.12.0) (2026-06-11)


### Features

* **core,dashboard:** unified attention taxonomy shared by CLI brief and dashboard ([#1352](https://github.com/costajohnt/oss-autopilot/issues/1352)) ([#1410](https://github.com/costajohnt/oss-autopilot/issues/1410)) ([a365a32](https://github.com/costajohnt/oss-autopilot/commit/a365a328c55aa1a8029c46767a4ea53fe99823d4))
* **core,mcp:** deterministic verify-issue — state, stateReason, and linked-PR claim classification ([#1409](https://github.com/costajohnt/oss-autopilot/issues/1409)) ([107150b](https://github.com/costajohnt/oss-autopilot/commit/107150b72fe68a1ec865578b660a1694111dc231))


### Bug Fixes

* **core:** list-move-tier errors on URL not found instead of quiet success ([#1355](https://github.com/costajohnt/oss-autopilot/issues/1355)) ([#1407](https://github.com/costajohnt/oss-autopilot/issues/1407)) ([5b046ff](https://github.com/costajohnt/oss-autopilot/commit/5b046ffb6e63a8c387a6cac54c91db84d94c6e92))

## [3.11.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.10.0...core-v3.11.0) (2026-06-11)


### Features

* **dashboard:** retry once then return 409 on state-write conflicts ([#1403](https://github.com/costajohnt/oss-autopilot/issues/1403)) ([ac72ed3](https://github.com/costajohnt/oss-autopilot/commit/ac72ed32920259a53c0263588770e823be1af8f8)), closes [#1397](https://github.com/costajohnt/oss-autopilot/issues/1397)
* **guidelines:** add guidelines list subcommand and MCP tool ([#1400](https://github.com/costajohnt/oss-autopilot/issues/1400)) ([085e127](https://github.com/costajohnt/oss-autopilot/commit/085e127f9b7c6e07bab814aad10b4a97eb5def99)), closes [#1393](https://github.com/costajohnt/oss-autopilot/issues/1393)
* **security:** wire the untrusted-content fence into agent-facing output ([#1396](https://github.com/costajohnt/oss-autopilot/issues/1396)) ([e1599a0](https://github.com/costajohnt/oss-autopilot/commit/e1599a0018f82282620130402829686d775a125a)), closes [#1372](https://github.com/costajohnt/oss-autopilot/issues/1372)


### Bug Fixes

* **agents:** align frontmatter tool grants with body instructions ([#1395](https://github.com/costajohnt/oss-autopilot/issues/1395)) ([47d5ed2](https://github.com/costajohnt/oss-autopilot/commit/47d5ed2d8557378e43e9550c171c81dbbac26282)), closes [#1377](https://github.com/costajohnt/oss-autopilot/issues/1377)
* **cli:** parse asynchronously so bootstrap errors surface actionably ([#1401](https://github.com/costajohnt/oss-autopilot/issues/1401)) ([4364c61](https://github.com/costajohnt/oss-autopilot/commit/4364c6115e9b984b39dc322fe3dc8a05bdd8280f)), closes [#1386](https://github.com/costajohnt/oss-autopilot/issues/1386)
* **core:** stop three per-item catches from swallowing rate-limit errors ([#1404](https://github.com/costajohnt/oss-autopilot/issues/1404)) ([867610c](https://github.com/costajohnt/oss-autopilot/commit/867610cc4be41585d8c31fddd5ecd2f2a1c059e9)), closes [#1391](https://github.com/costajohnt/oss-autopilot/issues/1391)
* **dashboard:** hoist PR-list memos above early returns (Rules of Hooks) ([#1384](https://github.com/costajohnt/oss-autopilot/issues/1384)) ([d03a30c](https://github.com/costajohnt/oss-autopilot/commit/d03a30c51723d97638490c977542f5b050391409)), closes [#1369](https://github.com/costajohnt/oss-autopilot/issues/1369)
* **dashboard:** reflect SPA shelve/unshelve immediately ([#1362](https://github.com/costajohnt/oss-autopilot/issues/1362)) ([37d1dc6](https://github.com/costajohnt/oss-autopilot/commit/37d1dc6f9688f325fb01c6bdbb156e401ea8c68e))
* **gist:** surface corrupt-Gist, permission, and rate-limit errors from bootstrap ([#1387](https://github.com/costajohnt/oss-autopilot/issues/1387)) ([2c6d2cd](https://github.com/costajohnt/oss-autopilot/commit/2c6d2cd59f6d0064c9a3cef82aea45b711ea54b2)), closes [#1367](https://github.com/costajohnt/oss-autopilot/issues/1367)
* **repo-vet:** stop reporting rate-limited release fetches as no releases ([#1390](https://github.com/costajohnt/oss-autopilot/issues/1390)) ([5939a1d](https://github.com/costajohnt/oss-autopilot/commit/5939a1da3edfb205a9cfade430a1c047031f95d9)), closes [#1373](https://github.com/costajohnt/oss-autopilot/issues/1373)
* **state:** preserve forensics and surface recovery when state.json is unparseable ([#1389](https://github.com/costajohnt/oss-autopilot/issues/1389)) ([d4beadb](https://github.com/costajohnt/oss-autopilot/commit/d4beadb74c8364ee507576e44ba315cbf1d93652)), closes [#1371](https://github.com/costajohnt/oss-autopilot/issues/1371)
* **state:** surface Gist checkpoint push failures in structured output ([#1388](https://github.com/costajohnt/oss-autopilot/issues/1388)) ([e4766f4](https://github.com/costajohnt/oss-autopilot/commit/e4766f447d2c961fb4e6d0328ee15f98c80f4279)), closes [#1370](https://github.com/costajohnt/oss-autopilot/issues/1370)

## [3.10.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.9.0...core-v3.10.0) (2026-05-18)


### Features

* **search:** bias scout searches with computeStrategy() recommendations ([#1350](https://github.com/costajohnt/oss-autopilot/issues/1350)) ([8309fa1](https://github.com/costajohnt/oss-autopilot/commit/8309fa10e90de2da59e28f0ebc8f21488340bb77))

## [3.9.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.8.0...core-v3.9.0) (2026-05-18)


### Features

* **strategy:** expose on-demand snapshot via CLI/MCP, rewire agent ([#1243](https://github.com/costajohnt/oss-autopilot/issues/1243) step 4) ([#1348](https://github.com/costajohnt/oss-autopilot/issues/1348)) ([912c0b4](https://github.com/costajohnt/oss-autopilot/commit/912c0b4a7eae7324a0270003d4f7634eaaf5d9b2))

## [3.8.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.7.0...core-v3.8.0) (2026-05-10)


### Features

* **workflow:** add upstream-drift check before push ([#1346](https://github.com/costajohnt/oss-autopilot/issues/1346)) ([1a3026b](https://github.com/costajohnt/oss-autopilot/commit/1a3026b2cc4a1ef176e2d30bae3686a9aca03555))

## [3.7.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.6.0...core-v3.7.0) (2026-05-10)


### Features

* integrate @oss-scout/core 0.9.0 (features command + stalled-PR detection) ([#1338](https://github.com/costajohnt/oss-autopilot/issues/1338)) ([4af41fc](https://github.com/costajohnt/oss-autopilot/commit/4af41fcde9acc545aa62f63c5b0255480e393ea8))


### Bug Fixes

* **startup:** throttle dashboard browser re-open to avoid duplicate tabs ([#1341](https://github.com/costajohnt/oss-autopilot/issues/1341)) ([89463b8](https://github.com/costajohnt/oss-autopilot/commit/89463b8710a7dc9f2d3444f5d6daef5306f22895))

## [3.6.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.5.0...core-v3.6.0) (2026-05-10)


### Features

* scanAIDisclosureRequirement + tri-modal AI-attribution rule ([#1269](https://github.com/costajohnt/oss-autopilot/issues/1269) Improvement C) ([#1327](https://github.com/costajohnt/oss-autopilot/issues/1327)) ([143df30](https://github.com/costajohnt/oss-autopilot/commit/143df302740eb8e0004c9323b9dcf93948e2f2a4))
* surface periodic strategy snapshot in /oss action menu ([#1270](https://github.com/costajohnt/oss-autopilot/issues/1270) Steps 2+3) ([#1332](https://github.com/costajohnt/oss-autopilot/issues/1332)) ([8e46106](https://github.com/costajohnt/oss-autopilot/commit/8e4610649970c6b17fd42fcc3103b873d073a6e9))


### Bug Fixes

* persist auto-detected skippedIssuesPath to state.config ([#1330](https://github.com/costajohnt/oss-autopilot/issues/1330)) ([#1337](https://github.com/costajohnt/oss-autopilot/issues/1337)) ([8352012](https://github.com/costajohnt/oss-autopilot/commit/8352012cf536d3c67d05d35e61eb060c87f576d5))
* rewrite Search-API "users do not exist" 422 to actionable ConfigurationError ([#1323](https://github.com/costajohnt/oss-autopilot/issues/1323)) ([#1324](https://github.com/costajohnt/oss-autopilot/issues/1324)) ([101de69](https://github.com/costajohnt/oss-autopilot/commit/101de697a36e671e348708ed45954bf3d30e78ca))

## [3.5.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.4.1...core-v3.5.0) (2026-05-08)


### Features

* /oss-guidelines slash command + edit-guidelines workflow ([#1283](https://github.com/costajohnt/oss-autopilot/issues/1283)) ([#1298](https://github.com/costajohnt/oss-autopilot/issues/1298)) ([7530edb](https://github.com/costajohnt/oss-autopilot/commit/7530edb34321f65d1befa92c8632037585b84bf7))
* add Reply with a question action to review-issue-replies ([#1290](https://github.com/costajohnt/oss-autopilot/issues/1290) step 3) ([#1312](https://github.com/costajohnt/oss-autopilot/issues/1312)) ([89d34ab](https://github.com/costajohnt/oss-autopilot/commit/89d34abb7dd0961ab2aee34dd1c714dfa4425c0a))
* add repo-vet CLI command ([#1271](https://github.com/costajohnt/oss-autopilot/issues/1271) step 1) ([#1318](https://github.com/costajohnt/oss-autopilot/issues/1318)) ([59e4a2e](https://github.com/costajohnt/oss-autopilot/commit/59e4a2e61705c252672f74c7604f09b538777bf9))
* auto-generate agent integration table in reference.md ([#1289](https://github.com/costajohnt/oss-autopilot/issues/1289) step 1+2) ([#1313](https://github.com/costajohnt/oss-autopilot/issues/1313)) ([f8b02b1](https://github.com/costajohnt/oss-autopilot/commit/f8b02b159c56cfd284989db9bedcc0f71581fb9c))
* auto-generate Local-only commands list from manifest --json ([#1289](https://github.com/costajohnt/oss-autopilot/issues/1289) step 4) ([#1315](https://github.com/costajohnt/oss-autopilot/issues/1315)) ([9f05e55](https://github.com/costajohnt/oss-autopilot/commit/9f05e559ffb37254b7ab6811d57d05e3b704911c))
* auto-generate workflow index in reference.md ([#1289](https://github.com/costajohnt/oss-autopilot/issues/1289) step 3) ([#1314](https://github.com/costajohnt/oss-autopilot/issues/1314)) ([b107700](https://github.com/costajohnt/oss-autopilot/commit/b10770097c6b08c91bf499c464b6bc3a9c23332d))
* configurable per-repo extraction categories ([#1284](https://github.com/costajohnt/oss-autopilot/issues/1284) minimum scope) ([#1300](https://github.com/costajohnt/oss-autopilot/issues/1300)) ([5d36668](https://github.com/costajohnt/oss-autopilot/commit/5d36668efd2218cea09ee01f89fdb3feb8323bac))
* extract markIssueListItemDone() to typed core ([#1299](https://github.com/costajohnt/oss-autopilot/issues/1299) part 2) ([#1303](https://github.com/costajohnt/oss-autopilot/issues/1303)) ([651e1d4](https://github.com/costajohnt/oss-autopilot/commit/651e1d4d873619c71bec8a361af06e629ad39642))
* guard-git-operations covers `pull --rebase` and `reset --hard` ([#1259](https://github.com/costajohnt/oss-autopilot/issues/1259)) ([#1281](https://github.com/costajohnt/oss-autopilot/issues/1281)) ([a655b02](https://github.com/costajohnt/oss-autopilot/commit/a655b028a7043ddaf29c7ff9c3159ae2e48745f9))
* guard-public-posts covers GitHub MCP family + gh subcommands ([#1260](https://github.com/costajohnt/oss-autopilot/issues/1260)) ([#1282](https://github.com/costajohnt/oss-autopilot/issues/1282)) ([b8a4964](https://github.com/costajohnt/oss-autopilot/commit/b8a49647f6601a88c32adcac11bd64d2720c919c))
* inject per-repo guidelines ([#867](https://github.com/costajohnt/oss-autopilot/issues/867)) at draft-first Step 1e ([#1294](https://github.com/costajohnt/oss-autopilot/issues/1294) steps 1-2) ([#1305](https://github.com/costajohnt/oss-autopilot/issues/1305)) ([4e287c1](https://github.com/costajohnt/oss-autopilot/commit/4e287c1e50f3d30f25e225b775c7a625e3c3c7e2))
* persist PR follow-up history in state.json ([#1277](https://github.com/costajohnt/oss-autopilot/issues/1277) Change 2) ([#1297](https://github.com/costajohnt/oss-autopilot/issues/1297)) ([a5f7e2f](https://github.com/costajohnt/oss-autopilot/commit/a5f7e2fc2935affa97cb7f4e9498479e9c3879d1))
* plan-review convergence loop and /plan-ready ([#1249](https://github.com/costajohnt/oss-autopilot/issues/1249)) ([#1267](https://github.com/costajohnt/oss-autopilot/issues/1267)) ([e84ba82](https://github.com/costajohnt/oss-autopilot/commit/e84ba82c20b9bfa7fb139df9f6ba62900650379a))
* pr-compliance-checker linked-issue verification ([#1246](https://github.com/costajohnt/oss-autopilot/issues/1246) B) ([#1261](https://github.com/costajohnt/oss-autopilot/issues/1261)) ([6694039](https://github.com/costajohnt/oss-autopilot/commit/66940393e44de482a228097ab7a2fe1dcb81beec))
* pr-compliance-checker template preservation check ([#1252](https://github.com/costajohnt/oss-autopilot/issues/1252) item 2) ([#1317](https://github.com/costajohnt/oss-autopilot/issues/1317)) ([3b211d5](https://github.com/costajohnt/oss-autopilot/commit/3b211d592e77b517c2f487d6113f27e17f5388fc))
* pr-responder temporal + relationship signals ([#1273](https://github.com/costajohnt/oss-autopilot/issues/1273)) ([#1321](https://github.com/costajohnt/oss-autopilot/issues/1321)) ([eb3f7c8](https://github.com/costajohnt/oss-autopilot/commit/eb3f7c8e4021004b964c6d162f222b7c202f05ca))
* pre-fetch per-repo guidelines for Phase A Tier 2 dispatches ([#1294](https://github.com/costajohnt/oss-autopilot/issues/1294) step 3) ([#1309](https://github.com/costajohnt/oss-autopilot/issues/1309)) ([8f10243](https://github.com/costajohnt/oss-autopilot/commit/8f10243047a3ae624a4bae86ac0e0c6e21a2176e))
* route repo-evaluator through repo-vet MCP tool ([#1271](https://github.com/costajohnt/oss-autopilot/issues/1271) step 3) ([#1320](https://github.com/costajohnt/oss-autopilot/issues/1320)) ([0c22ac3](https://github.com/costajohnt/oss-autopilot/commit/0c22ac3a8b8648769b3ed913bebc19d613434206))
* surface dashboard build status in /oss startup output ([#1293](https://github.com/costajohnt/oss-autopilot/issues/1293)) ([#1308](https://github.com/costajohnt/oss-autopilot/issues/1308)) ([5c0f3f5](https://github.com/costajohnt/oss-autopilot/commit/5c0f3f5f414d06398ba880cb1fef0d3db1a52713))
* surface user comment body alongside maintainer reply ([#1290](https://github.com/costajohnt/oss-autopilot/issues/1290) step 2) ([#1306](https://github.com/costajohnt/oss-autopilot/issues/1306)) ([492239a](https://github.com/costajohnt/oss-autopilot/commit/492239a94527382cdf10df35aab9070d9eaec6e3))
* workflow-step state tracking core ([#1280](https://github.com/costajohnt/oss-autopilot/issues/1280) minimum scope) ([#1301](https://github.com/costajohnt/oss-autopilot/issues/1301)) ([63a5c75](https://github.com/costajohnt/oss-autopilot/commit/63a5c75c020873481748e6403835b67132a36c38))


### Bug Fixes

* auto-format hook skips when ANY branch remote is non-personal ([#1257](https://github.com/costajohnt/oss-autopilot/issues/1257)) ([#1278](https://github.com/costajohnt/oss-autopilot/issues/1278)) ([5046743](https://github.com/costajohnt/oss-autopilot/commit/5046743ca73bdc29ecd3ee0a549fd0dead421bf9))
* gate SessionStart PR health summary on cache freshness ([#1255](https://github.com/costajohnt/oss-autopilot/issues/1255)) ([#1276](https://github.com/costajohnt/oss-autopilot/issues/1276)) ([54fad9f](https://github.com/costajohnt/oss-autopilot/commit/54fad9ff4115770cc2a51245be0cd45bcadc7704))
* parseIssueList dedupe + recognize Hold/Continue watch ([#1179](https://github.com/costajohnt/oss-autopilot/issues/1179)) ([#1256](https://github.com/costajohnt/oss-autopilot/issues/1256)) ([2630849](https://github.com/costajohnt/oss-autopilot/commit/26308494b678fbb95fe414aa057dfc2072a3c030))
* pr-compliance-checker `read` ref + extract-to-core ([#1245](https://github.com/costajohnt/oss-autopilot/issues/1245)) ([#1258](https://github.com/costajohnt/oss-autopilot/issues/1258)) ([7d4337c](https://github.com/costajohnt/oss-autopilot/commit/7d4337c34fd7d42e6c336fb40d1fed6b76ceb3c9))
* pre-3.5.0 release blockers (review-loop convergence) ([#1322](https://github.com/costajohnt/oss-autopilot/issues/1322)) ([9508fdf](https://github.com/costajohnt/oss-autopilot/commit/9508fdf392691cf66b319fcd7b892e40f1416630))
* state.json fail-loud on 412-conflict merge re-apply ([#1235](https://github.com/costajohnt/oss-autopilot/issues/1235)) ([#1253](https://github.com/costajohnt/oss-autopilot/issues/1253)) ([5b1f1ad](https://github.com/costajohnt/oss-autopilot/commit/5b1f1ad2514166a65465dc80bc9f937b244d2502))

## [3.4.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.4.0...core-v3.4.1) (2026-05-07)


### Bug Fixes

* **validation:** reject octocat and monalisa as placeholder usernames ([#1240](https://github.com/costajohnt/oss-autopilot/issues/1240)) ([14f9d98](https://github.com/costajohnt/oss-autopilot/commit/14f9d98efdd774ce186e1c9d2f6e6095bbc206a8))

## [3.4.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.3.0...core-v3.4.0) (2026-05-06)


### Features

* **pr-comments-fetcher:** return failures list alongside bundles ([#1209](https://github.com/costajohnt/oss-autopilot/issues/1209) L8) ([#1233](https://github.com/costajohnt/oss-autopilot/issues/1233)) ([1d48d37](https://github.com/costajohnt/oss-autopilot/commit/1d48d37e20465b38ff6cbed32cdca37247009995))


### Bug Fixes

* **cli:** let leaf subcommands inherit parent group's localOnly flag ([#1208](https://github.com/costajohnt/oss-autopilot/issues/1208) M2) ([#1221](https://github.com/costajohnt/oss-autopilot/issues/1221)) ([d2095f8](https://github.com/costajohnt/oss-autopilot/commit/d2095f8eec75cef4c130c74cf0e3a6842548c42d))
* **dashboard:** surface background-refresh failure via X-Dashboard-Stale header ([#1205](https://github.com/costajohnt/oss-autopilot/issues/1205)) ([#1231](https://github.com/costajohnt/oss-autopilot/issues/1231)) ([21e8560](https://github.com/costajohnt/oss-autopilot/commit/21e8560383de214c3454fbb5531fff2e8f7a1a42))
* **guidelines:** drop PRs with empty/malformed timestamps from recency cliff ([#1204](https://github.com/costajohnt/oss-autopilot/issues/1204)) ([#1230](https://github.com/costajohnt/oss-autopilot/issues/1230)) ([7621adb](https://github.com/costajohnt/oss-autopilot/commit/7621adb5fb2ff097864f0c331992372896ed1fa6))
* **validation:** reject placeholder GitHub usernames at write side ([#1226](https://github.com/costajohnt/oss-autopilot/issues/1226)) ([24a85db](https://github.com/costajohnt/oss-autopilot/commit/24a85db20255939e44b80a82112cf652b01dd231))

## [3.3.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.2.0...core-v3.3.0) (2026-05-04)


### Features

* add manifest command + plugin/CLI contract verification ([#1190](https://github.com/costajohnt/oss-autopilot/issues/1190)) ([#1194](https://github.com/costajohnt/oss-autopilot/issues/1194)) ([887d819](https://github.com/costajohnt/oss-autopilot/commit/887d81904cb25a21ee52a546d88969f78e99c7f3))
* **security:** add wrapUntrustedContent fence + prompt-injection corpus ([#1192](https://github.com/costajohnt/oss-autopilot/issues/1192)) ([#1197](https://github.com/costajohnt/oss-autopilot/issues/1197)) ([e86c8d2](https://github.com/costajohnt/oss-autopilot/commit/e86c8d21d5711717ab68f297bb26954f73354a0c))


### Bug Fixes

* 3 critical data-loss bugs from 2026-04-28 audit ([#1200](https://github.com/costajohnt/oss-autopilot/issues/1200), [#1201](https://github.com/costajohnt/oss-autopilot/issues/1201), [#1202](https://github.com/costajohnt/oss-autopilot/issues/1202)) ([#1210](https://github.com/costajohnt/oss-autopilot/issues/1210)) ([8ae74ce](https://github.com/costajohnt/oss-autopilot/commit/8ae74cec0dd9e860b89db95711cd8bdd7884a040))
* surface stale-cache fallback from refreshFromGist in --json ([#1193](https://github.com/costajohnt/oss-autopilot/issues/1193)) ([#1198](https://github.com/costajohnt/oss-autopilot/issues/1198)) ([c68f130](https://github.com/costajohnt/oss-autopilot/commit/c68f130069052aff3ecaf770708c9e0dffd618da))

## [3.2.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.1.0...core-v3.2.0) (2026-04-26)


### Features

* add commentsFetchedAt + v4 state migration ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 1) ([#1171](https://github.com/costajohnt/oss-autopilot/issues/1171)) ([8183651](https://github.com/costajohnt/oss-autopilot/commit/818365149a2de54d592456413be24c8f717a37ed))
* guidelines CLI commands (view/store/reset/fetch-corpus) ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 4) ([#1175](https://github.com/costajohnt/oss-autopilot/issues/1175)) ([202291e](https://github.com/costajohnt/oss-autopilot/commit/202291e75413525047c9c0e6eaafa33fe163ec2e))
* guidelines-store — Gist freeform document API for per-repo guidelines ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 2) ([#1173](https://github.com/costajohnt/oss-autopilot/issues/1173)) ([d0c8ed3](https://github.com/costajohnt/oss-autopilot/commit/d0c8ed3e57e0fc824ab54509bffab78b8a11c74e))
* **plugin:** add extract-learnings workflow + post-merge nudge ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 7) ([#1178](https://github.com/costajohnt/oss-autopilot/issues/1178)) ([9cdfdb0](https://github.com/costajohnt/oss-autopilot/commit/9cdfdb06c37f91231b912f7792567b49af8ac199))
* **plugin:** inject per-repo guidelines at claim time ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 6) ([#1177](https://github.com/costajohnt/oss-autopilot/issues/1177)) ([d4c3555](https://github.com/costajohnt/oss-autopilot/commit/d4c3555ac3a5f3f7301e70622313550adbaf52ae))
* pr-comments-fetcher — fetch raw comment bundles for closed/merged PRs ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 3) ([#1174](https://github.com/costajohnt/oss-autopilot/issues/1174)) ([d7a25a2](https://github.com/costajohnt/oss-autopilot/commit/d7a25a2cc23bcbb7a0be6782cd9af6a02de9b368))

## [3.1.0](https://github.com/costajohnt/oss-autopilot/compare/core-v3.0.1...core-v3.1.0) (2026-04-26)


### Features

* **vet:** consume slmTriage from scout 0.7.1 + add config surface ([#1170](https://github.com/costajohnt/oss-autopilot/issues/1170)) ([6728542](https://github.com/costajohnt/oss-autopilot/commit/6728542d161bfdc22b8e5d5d416a6771bb650b9f))
* **vet:** surface linkedPRClassification + antiLLMPolicy from scout 0.6.0 ([#1168](https://github.com/costajohnt/oss-autopilot/issues/1168)) ([031adee](https://github.com/costajohnt/oss-autopilot/commit/031adeebf0c9ab764da7837bdf4fda18e0727304))

## [3.0.1](https://github.com/costajohnt/oss-autopilot/compare/core-v3.0.0...core-v3.0.1) (2026-04-26)


### Bug Fixes

* preserve upstream PR templates and checklists ([#1165](https://github.com/costajohnt/oss-autopilot/issues/1165)) ([0512459](https://github.com/costajohnt/oss-autopilot/commit/0512459d660f618b0557127c9c6660e21512cb46))

## [3.0.0](https://github.com/costajohnt/oss-autopilot/compare/core-v2.0.0...core-v3.0.0) (2026-04-26)


### ⚠ BREAKING CHANGES

* users on Node 20 will see npm EBADENGINE warnings on install. Upgrade to Node 22 (LTS) or 24 (current) before pulling this release.

### Features

* drop Node 20 support, require Node 22+ ([#1162](https://github.com/costajohnt/oss-autopilot/issues/1162)) ([f88a064](https://github.com/costajohnt/oss-autopilot/commit/f88a0647c0bf7df295442b7615e1a9e131152b14))

## [2.0.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.17.4...core-v2.0.0) (2026-04-25)


### ⚠ BREAKING CHANGES

* external consumers importing from @oss-autopilot/core/utils (or any deep-path equivalent) will fail to resolve. The replacement modules are:   - paths      → getDataDir, getStatePath, getBackupDir, getCacheDir,                  getGistIdPath, getStateCachePath, stateFileExists,                  getCLIVersion   - urls       → parseGitHubUrl, extractOwnerRepo, splitRepo, isOwnRepo,                  ParsedGitHubUrl   - dates      → daysBetween, formatRelativeTime, byDateDescending   - auth       → getGitHubToken, getGitHubTokenAsync, requireGitHubToken,                  resetGitHubTokenCache, detectGitHubUsername   - concurrency → DEFAULT_CONCURRENCY, sleep, runWorkerPool
* the MCP tools `read` and `untrack` are no longer registered. Clients that hard-coded these tool names will get a "tool not found" error from listTools / callTool. The CLI commands of the same name are also removed; scripts that invoked them get "unknown command" from commander.

### Features

* add /pr-ready slash command and wait-for-ci.sh helper ([#1153](https://github.com/costajohnt/oss-autopilot/issues/1153)) ([20809d4](https://github.com/costajohnt/oss-autopilot/commit/20809d460fe5e5c74fe6ea7ebfb70fa21ab50a5f))
* **cli:** list-move-tier command ([#1107](https://github.com/costajohnt/oss-autopilot/issues/1107)) ([#1140](https://github.com/costajohnt/oss-autopilot/issues/1140)) ([37d813d](https://github.com/costajohnt/oss-autopilot/commit/37d813d619998ae57b259be266483f4faed18a0c))
* **core:** Gist ETag + conflict resolution for state sync ([#1115](https://github.com/costajohnt/oss-autopilot/issues/1115)) ([#1145](https://github.com/costajohnt/oss-autopilot/issues/1145)) ([d6ec379](https://github.com/costajohnt/oss-autopilot/commit/d6ec37939de7d3d11a4a7235f6bf7f4b8870533e))
* remove core/utils.ts re-export shim ([#1141](https://github.com/costajohnt/oss-autopilot/issues/1141)) ([#1158](https://github.com/costajohnt/oss-autopilot/issues/1158)) ([85d5255](https://github.com/costajohnt/oss-autopilot/commit/85d525580ad502566fb91eac6dccab6ff1ce695f))
* remove read/untrack v1 stubs from CLI and MCP server ([#1133](https://github.com/costajohnt/oss-autopilot/issues/1133)) ([#1157](https://github.com/costajohnt/oss-autopilot/issues/1157)) ([a957feb](https://github.com/costajohnt/oss-autopilot/commit/a957febd0341c447a4e4f735b83d086c025b0694))


### Bug Fixes

* **core:** validate URLs on write-side of addMergedPRs/addClosedPRs ([#1120](https://github.com/costajohnt/oss-autopilot/issues/1120)) ([#1128](https://github.com/costajohnt/oss-autopilot/issues/1128)) ([592a727](https://github.com/costajohnt/oss-autopilot/commit/592a727f24da6b5f8980aa61e1def4f0a8496074))

## [1.17.4](https://github.com/costajohnt/oss-autopilot/compare/core-v1.17.3...core-v1.17.4) (2026-04-24)


### Bug Fixes

* **dashboard:** stop lazy chart init from calling ChartPanel on remount ([#1124](https://github.com/costajohnt/oss-autopilot/issues/1124)) ([a918350](https://github.com/costajohnt/oss-autopilot/commit/a918350cbbd89e05f4fa5d627e8fe4fe8b1b6e28))

## [1.17.3](https://github.com/costajohnt/oss-autopilot/compare/core-v1.17.2...core-v1.17.3) (2026-04-22)


### Bug Fixes

* **dashboard:** eliminate 'process is not defined' in browser bundle ([#1121](https://github.com/costajohnt/oss-autopilot/issues/1121)) ([218d1d3](https://github.com/costajohnt/oss-autopilot/commit/218d1d33bf6ba76c19175b8358f166966343efb4))

## [1.17.2](https://github.com/costajohnt/oss-autopilot/compare/core-v1.17.1...core-v1.17.2) (2026-04-22)


### Bug Fixes

* **startup:** always launch dashboard and auto-repair placeholder usernames ([#1103](https://github.com/costajohnt/oss-autopilot/issues/1103)) ([02479d4](https://github.com/costajohnt/oss-autopilot/commit/02479d4bc93d42200aee9ea86bc89483d8b3451c))

## [1.17.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.17.0...core-v1.17.1) (2026-04-22)


### Bug Fixes

* **pr-monitor:** warn when configured username does not match authenticated viewer ([#1101](https://github.com/costajohnt/oss-autopilot/issues/1101)) ([1b8f6dc](https://github.com/costajohnt/oss-autopilot/commit/1b8f6dca6385918d2e79aea9cf87b1a63381529b))
* **startup:** focus dashboard tab on /oss when server is already running ([#1100](https://github.com/costajohnt/oss-autopilot/issues/1100)) ([a570823](https://github.com/costajohnt/oss-autopilot/commit/a57082355457decb59269ec971ba850229fcab97))

## [1.17.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.16.2...core-v1.17.0) (2026-04-22)


### Features

* **cli:** add doctor command, rename check-integration → orphan-files ([#1039](https://github.com/costajohnt/oss-autopilot/issues/1039)) ([#1074](https://github.com/costajohnt/oss-autopilot/issues/1074)) ([2b3606b](https://github.com/costajohnt/oss-autopilot/commit/2b3606bd2aae8e2d7a8f65188cc131569f38b401))
* **dashboard:** live demo features — chart entrance + Shift+C celebrate ([#940](https://github.com/costajohnt/oss-autopilot/issues/940)) ([#1097](https://github.com/costajohnt/oss-autopilot/issues/1097)) ([81f7c16](https://github.com/costajohnt/oss-autopilot/commit/81f7c16b4f4d72ccfedc459732e4efdc931d8a37))


### Bug Fixes

* **agents:** declare explicit model tier instead of inherit ([#1040](https://github.com/costajohnt/oss-autopilot/issues/1040)) ([#1075](https://github.com/costajohnt/oss-autopilot/issues/1075)) ([07bd37f](https://github.com/costajohnt/oss-autopilot/commit/07bd37f862a72c5ff8e7321d57088b21ab78c9c8))
* **agents:** narrow tool allowlists, drop mcp__* wildcard ([#1064](https://github.com/costajohnt/oss-autopilot/issues/1064)) ([25f26e9](https://github.com/costajohnt/oss-autopilot/commit/25f26e902139f24706eeae0ef7e9fce922e71028))
* **cli:** shelve/unshelve CLI now emits ShelveOutput, not MoveOutput ([#1037](https://github.com/costajohnt/oss-autopilot/issues/1037)) ([#1072](https://github.com/costajohnt/oss-autopilot/issues/1072)) ([b993443](https://github.com/costajohnt/oss-autopilot/commit/b993443a4127c7b16d2adbe92fdefbfc8304db64))
* **cli:** single source-of-truth config key registry ([#1038](https://github.com/costajohnt/oss-autopilot/issues/1038)) ([#1073](https://github.com/costajohnt/oss-autopilot/issues/1073)) ([b294d01](https://github.com/costajohnt/oss-autopilot/commit/b294d01e8bc1ffa60bdb0de6ac8a31a76c8972a6))
* close UM1 plugin/agent prose polish findings M1/M4/M5/M6/M10/M14 ([#1091](https://github.com/costajohnt/oss-autopilot/issues/1091)) ([2d44dbd](https://github.com/costajohnt/oss-autopilot/commit/2d44dbd1ea535181473888181526be1232c46d5b))
* close UM2 hook + CLI PR-flow hygiene findings M17/M20/M21/M23/M24 ([#1092](https://github.com/costajohnt/oss-autopilot/issues/1092)) ([f120802](https://github.com/costajohnt/oss-autopilot/commit/f1208021893eee03366565ddf9fca1ba01af20f5))
* close UM3 infra + core-domain findings M25/M27/M30/M34 ([#1093](https://github.com/costajohnt/oss-autopilot/issues/1093)) ([fc3e422](https://github.com/costajohnt/oss-autopilot/commit/fc3e422c3029453816345ead576f93aebacdd51b))
* close UM4 dashboard SPA + MCP polish findings M37/M38/M39/M40/M41 ([#1094](https://github.com/costajohnt/oss-autopilot/issues/1094)) ([076c00f](https://github.com/costajohnt/oss-autopilot/commit/076c00f4d85daaf095b42415fbb96c9bcf5abfc8))
* **commands:** remove phantom scoreThreshold/showHealthCheck config refs ([#1063](https://github.com/costajohnt/oss-autopilot/issues/1063)) ([6cf0aab](https://github.com/costajohnt/oss-autopilot/commit/6cf0aabd341e529e6f88b86251f688b85a0208ab))
* **daily:** surface non-fatal pipeline failures via DailyOutput.warnings ([#1042](https://github.com/costajohnt/oss-autopilot/issues/1042)) ([#1077](https://github.com/costajohnt/oss-autopilot/issues/1077)) ([498d90a](https://github.com/costajohnt/oss-autopilot/commit/498d90a794c55950d8d68005f8b9d17bd2ddd9aa))
* **dashboard:** 404 + focus + skip-link on every route ([#1052](https://github.com/costajohnt/oss-autopilot/issues/1052)) ([#1088](https://github.com/costajohnt/oss-autopilot/issues/1088)) ([482812a](https://github.com/costajohnt/oss-autopilot/commit/482812aa2211619d1619dd84a01825beb3e1f956))
* **dashboard:** add root error boundary + runtime schema validation ([#1050](https://github.com/costajohnt/oss-autopilot/issues/1050)) ([#1085](https://github.com/costajohnt/oss-autopilot/issues/1085)) ([e650d15](https://github.com/costajohnt/oss-autopilot/commit/e650d15bc1a9db634a40643b9f76475122491041))
* **dashboard:** surface partial-fetch failures to the user ([#1035](https://github.com/costajohnt/oss-autopilot/issues/1035)) ([#1070](https://github.com/costajohnt/oss-autopilot/issues/1070)) ([6c0386c](https://github.com/costajohnt/oss-autopilot/commit/6c0386c63524a99623b3ff6b74076bcb29965d2e))
* **dashboard:** tighten dashboard server auth for [#1031](https://github.com/costajohnt/oss-autopilot/issues/1031) ([#1066](https://github.com/costajohnt/oss-autopilot/issues/1066)) ([411b793](https://github.com/costajohnt/oss-autopilot/commit/411b7936aa90c523508338600c08189ea8766228))
* **hooks:** expand guard-public-posts coverage ([#1032](https://github.com/costajohnt/oss-autopilot/issues/1032)) ([#1067](https://github.com/costajohnt/oss-autopilot/issues/1067)) ([a280775](https://github.com/costajohnt/oss-autopilot/commit/a28077525fd0059222ae9380c6eef00dc6322711))
* **hooks:** gate auto-format-before-push behind opt-in config ([#1045](https://github.com/costajohnt/oss-autopilot/issues/1045)) ([#1080](https://github.com/costajohnt/oss-autopilot/issues/1080)) ([1e3dd20](https://github.com/costajohnt/oss-autopilot/commit/1e3dd20d9de9d0b1eb0137dd48a02abc52c11ca2))
* **hooks:** preserve local edits to marketplace clone on auto-refresh ([#1061](https://github.com/costajohnt/oss-autopilot/issues/1061)) ([c80ed26](https://github.com/costajohnt/oss-autopilot/commit/c80ed26822315111c978ea8247e41dc1a297ecc2))
* **mcp:** align README and server.json with reality ([#1065](https://github.com/costajohnt/oss-autopilot/issues/1065)) ([414cd14](https://github.com/costajohnt/oss-autopilot/commit/414cd14050c9565507ce5939f41a8fee517a92d3))
* **release-please:** server.json path is relative to component root ([#1099](https://github.com/costajohnt/oss-autopilot/issues/1099)) ([8e3d9f6](https://github.com/costajohnt/oss-autopilot/commit/8e3d9f6f09f2887253637fcaed2c443d667ca07e))
* **release-please:** track server.json version under mcp-server component ([#1098](https://github.com/costajohnt/oss-autopilot/issues/1098)) ([d240f60](https://github.com/costajohnt/oss-autopilot/commit/d240f608bbe2286e2f51364b10aec75605f2030e))
* **search,vet-list:** defend against scout data-contract drift ([#1043](https://github.com/costajohnt/oss-autopilot/issues/1043)) ([#1078](https://github.com/costajohnt/oss-autopilot/issues/1078)) ([838ce18](https://github.com/costajohnt/oss-autopilot/commit/838ce188b59d387cce7fbf899bba03741f65705f))
* **startup:** use async token resolver so gh CLI fallback fires ([#1041](https://github.com/costajohnt/oss-autopilot/issues/1041)) ([#1076](https://github.com/costajohnt/oss-autopilot/issues/1076)) ([561f869](https://github.com/costajohnt/oss-autopilot/commit/561f869af37eac29a9b036b3aca69b1f25ffa700))
* **state:** Gist checkpoint after mutating PR-flow commands ([#1036](https://github.com/costajohnt/oss-autopilot/issues/1036)) ([#1071](https://github.com/costajohnt/oss-autopilot/issues/1071)) ([b8237cd](https://github.com/costajohnt/oss-autopilot/commit/b8237cddccf5eea2c620beb8a2f2e37fa1fdae4a))
* **state:** optimistic compare-and-swap for state.json writes ([#1030](https://github.com/costajohnt/oss-autopilot/issues/1030)) ([#1069](https://github.com/costajohnt/oss-autopilot/issues/1069)) ([d175a94](https://github.com/costajohnt/oss-autopilot/commit/d175a94d7552990e822ad7dd3d1da70593306f4f))
* **status:** parse dates numerically instead of lex-comparing strings ([#1044](https://github.com/costajohnt/oss-autopilot/issues/1044)) ([#1079](https://github.com/costajohnt/oss-autopilot/issues/1079)) ([08f0a2a](https://github.com/costajohnt/oss-autopilot/commit/08f0a2a2620a2423855acd4ba77a7b6796dc32d3))


### Performance Improvements

* **dashboard:** code-split Chart.js and canvas-confetti off critical path ([#1051](https://github.com/costajohnt/oss-autopilot/issues/1051)) ([#1086](https://github.com/costajohnt/oss-autopilot/issues/1086)) ([9202780](https://github.com/costajohnt/oss-autopilot/commit/9202780976e768d85358aceab3f12f67ea549e6a))

## [1.16.2](https://github.com/costajohnt/oss-autopilot/compare/core-v1.16.1...core-v1.16.2) (2026-04-21)


### Bug Fixes

* **dashboard:** allow blob: workers in CSP for canvas-confetti ([#1025](https://github.com/costajohnt/oss-autopilot/issues/1025)) ([fa3f881](https://github.com/costajohnt/oss-autopilot/commit/fa3f881776574af937b0425a5157e164b1a3b6ff))

## [1.16.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.16.0...core-v1.16.1) (2026-04-21)


### Bug Fixes

* **hooks:** detect dashboard source changes in session-start rebuild check ([#1023](https://github.com/costajohnt/oss-autopilot/issues/1023)) ([a657b82](https://github.com/costajohnt/oss-autopilot/commit/a657b82b0a9843381f757cfca98190005eee7121)), closes [#1022](https://github.com/costajohnt/oss-autopilot/issues/1022)

## [1.16.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.15.2...core-v1.16.0) (2026-04-20)


### Features

* **dashboard:** animated stat counters and manual celebrate button ([#1019](https://github.com/costajohnt/oss-autopilot/issues/1019)) ([e2b2966](https://github.com/costajohnt/oss-autopilot/commit/e2b296659300314578a73615e746e15b947cf7a7))


### Bug Fixes

* audit-v2 batch 1 — daysBetween docs + three silent catches ([#1009](https://github.com/costajohnt/oss-autopilot/issues/1009)) ([7c89a74](https://github.com/costajohnt/oss-autopilot/commit/7c89a74d9d97af6a8e45b28bae6d6bf051b33d4a))
* **ci:** skip Dependabot Triage gracefully when token secret is missing ([#1010](https://github.com/costajohnt/oss-autopilot/issues/1010)) ([eb3c876](https://github.com/costajohnt/oss-autopilot/commit/eb3c876e4551757177240107f282b7842ace9149))

## [1.15.2](https://github.com/costajohnt/oss-autopilot/compare/core-v1.15.1...core-v1.15.2) (2026-04-19)


### Bug Fixes

* parse skipped-issues file into scout state ([#989](https://github.com/costajohnt/oss-autopilot/issues/989)) ([#990](https://github.com/costajohnt/oss-autopilot/issues/990)) ([ecc602e](https://github.com/costajohnt/oss-autopilot/commit/ecc602ed86868ef0a5158034bc98a6e2bb53ecc4))
* persist /oss Pick-from-list skips to skipped-issues file ([#1008](https://github.com/costajohnt/oss-autopilot/issues/1008)) ([d500e7c](https://github.com/costajohnt/oss-autopilot/commit/d500e7c06d3514824e889f0b05169bffdbf33f64))

## [1.15.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.15.0...core-v1.15.1) (2026-04-19)


### Bug Fixes

* **dashboard:** align shelvedPRUrls with stats.shelvedPRs count ([#984](https://github.com/costajohnt/oss-autopilot/issues/984)) ([a3cb258](https://github.com/costajohnt/oss-autopilot/commit/a3cb258b7dd45be8b72916c956a53dc83cd602b6)), closes [#981](https://github.com/costajohnt/oss-autopilot/issues/981)

## [1.15.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.14.0...core-v1.15.0) (2026-04-19)


### Features

* pass open-PR repos to oss-scout search via bridge ([#974](https://github.com/costajohnt/oss-autopilot/issues/974)) ([76a6925](https://github.com/costajohnt/oss-autopilot/commit/76a6925c1654fe35fe79e20a3a0278d43d54f9cd))

## [1.14.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.13.1...core-v1.14.0) (2026-04-19)


### Features

* **agents:** add success-likelihood grade to issue-scout output ([#858](https://github.com/costajohnt/oss-autopilot/issues/858)) ([#954](https://github.com/costajohnt/oss-autopilot/issues/954)) ([81d0f07](https://github.com/costajohnt/oss-autopilot/commit/81d0f0763bb0781669aa1f67c5fbbea77a320161))
* **workflows:** skip PR response comment when diff speaks for itself ([#904](https://github.com/costajohnt/oss-autopilot/issues/904)) ([#950](https://github.com/costajohnt/oss-autopilot/issues/950)) ([6981083](https://github.com/costajohnt/oss-autopilot/commit/69810836f9ab635142bfc45c486b7aba797ab411))


### Bug Fixes

* **agents:** auto-skip repos with anti-LLM/AI policies during vetting ([#911](https://github.com/costajohnt/oss-autopilot/issues/911)) ([#953](https://github.com/costajohnt/oss-autopilot/issues/953)) ([b496482](https://github.com/costajohnt/oss-autopilot/commit/b496482cb628767ddae3e02c2be947265b4914fe))
* **agents:** distinguish user's own PR from competition in issue-scout ([#910](https://github.com/costajohnt/oss-autopilot/issues/910)) ([#952](https://github.com/costajohnt/oss-autopilot/issues/952)) ([978b8d4](https://github.com/costajohnt/oss-autopilot/commit/978b8d49c2079f4b104be271e3e6220afef480ab))
* invalidate dashboard cache when issue list file is edited ([#924](https://github.com/costajohnt/oss-autopilot/issues/924)) ([#947](https://github.com/costajohnt/oss-autopilot/issues/947)) ([b227ea5](https://github.com/costajohnt/oss-autopilot/commit/b227ea5e73817cb01727bdb312eb0a1d660f8461))
* **workflows:** split commit and push into separate confirmations ([#941](https://github.com/costajohnt/oss-autopilot/issues/941)) ([#949](https://github.com/costajohnt/oss-autopilot/issues/949)) ([e1c670a](https://github.com/costajohnt/oss-autopilot/commit/e1c670a7692e708df44c89ad2a9ba69e801b6d01))

## [1.13.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.13.0...core-v1.13.1) (2026-04-18)


### Bug Fixes

* exclude Skip sub-bullet items from availableCount ([#907](https://github.com/costajohnt/oss-autopilot/issues/907)) ([#946](https://github.com/costajohnt/oss-autopilot/issues/946)) ([a5fe6b9](https://github.com/costajohnt/oss-autopilot/commit/a5fe6b927d3f6af04998d9d346e4e7196da8e303))

## [1.13.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.12.2...core-v1.13.0) (2026-04-10)


### Features

* **dashboard:** celebration toast when new PRs are merged ([#937](https://github.com/costajohnt/oss-autopilot/issues/937)) ([0e23017](https://github.com/costajohnt/oss-autopilot/commit/0e23017b12a311d31a7468c9effe03770542c470))

## [1.12.2](https://github.com/costajohnt/oss-autopilot/compare/core-v1.12.1...core-v1.12.2) (2026-04-08)


### Bug Fixes

* **dashboard:** resolve blank page from duplicate Preact instances ([#931](https://github.com/costajohnt/oss-autopilot/issues/931)) ([e07f243](https://github.com/costajohnt/oss-autopilot/commit/e07f243eac20acb6e2af7ed58312273a1d2b1154))

## [1.12.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.12.0...core-v1.12.1) (2026-04-01)


### Bug Fixes

* address comprehensive repo audit findings ([#918](https://github.com/costajohnt/oss-autopilot/issues/918)) ([bce859c](https://github.com/costajohnt/oss-autopilot/commit/bce859cb19a58b88526d75ad809f6b8c72909be3))

## [1.12.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.11.0...core-v1.12.0) (2026-03-30)


### Features

* replace search engine with @oss-scout/core dependency ([#902](https://github.com/costajohnt/oss-autopilot/issues/902)) ([3e62090](https://github.com/costajohnt/oss-autopilot/commit/3e62090918195ad0c7d68689cca2b539c0772ae5))


### Bug Fixes

* update agents, add vet-list to MCP, map excludeOrgs ([#905](https://github.com/costajohnt/oss-autopilot/issues/905)) ([822bdea](https://github.com/costajohnt/oss-autopilot/commit/822bdea29d52bf1033f37242daf850fe680b4a82))

## [1.11.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.10.0...core-v1.11.0) (2026-03-27)


### Features

* activate Gist persistence layer with opt-in setup, scope check, dashboard refresh, and unlink ([#885](https://github.com/costajohnt/oss-autopilot/issues/885)) ([2a1de39](https://github.com/costajohnt/oss-autopilot/commit/2a1de397660cc85a533ae8a9434d3cb0e13356ab)), closes [#883](https://github.com/costajohnt/oss-autopilot/issues/883)
* add configurable diff viewer preference (SourceTree, VS Code, inline) ([#898](https://github.com/costajohnt/oss-autopilot/issues/898)) ([1b3825b](https://github.com/costajohnt/oss-autopilot/commit/1b3825b2bfd8ddf312a29e1420c5f7aaf619f2fe)), closes [#890](https://github.com/costajohnt/oss-autopilot/issues/890)
* add pre-push hook to auto-run project formatter before pushing ([#901](https://github.com/costajohnt/oss-autopilot/issues/901)) ([ef7c5f9](https://github.com/costajohnt/oss-autopilot/commit/ef7c5f903cd05a4ce8b614761e1dafa507502b5c)), closes [#893](https://github.com/costajohnt/oss-autopilot/issues/893)
* **dashboard:** split active PRs into Need Attention and Waiting cards ([#894](https://github.com/costajohnt/oss-autopilot/issues/894)) ([d0f5986](https://github.com/costajohnt/oss-autopilot/commit/d0f5986417974a7e16e52a3ff0b0f93961ab3f18))


### Bug Fixes

* check Node.js version compatibility before implementing changes ([#900](https://github.com/costajohnt/oss-autopilot/issues/900)) ([db12bd9](https://github.com/costajohnt/oss-autopilot/commit/db12bd9cbe5a5772e3613148271be67cfd9e0f7b)), closes [#892](https://github.com/costajohnt/oss-autopilot/issues/892)
* display full URLs instead of markdown links in CLI output ([#897](https://github.com/costajohnt/oss-autopilot/issues/897)) ([458b5ba](https://github.com/costajohnt/oss-autopilot/commit/458b5ba4a5711a6d35a9395ce3424292e7914aba)), closes [#889](https://github.com/costajohnt/oss-autopilot/issues/889)
* enforce code verification in investigation agents ([#896](https://github.com/costajohnt/oss-autopilot/issues/896)) ([8ab168f](https://github.com/costajohnt/oss-autopilot/commit/8ab168fec13d8b830a85d945e6da41ba7b0d93f5)), closes [#888](https://github.com/costajohnt/oss-autopilot/issues/888)
* enforce scope discipline — only implement what the maintainer asked for ([#899](https://github.com/costajohnt/oss-autopilot/issues/899)) ([0eec7a3](https://github.com/costajohnt/oss-autopilot/commit/0eec7a3a2e8c942a233600ad489a17e247250c71)), closes [#891](https://github.com/costajohnt/oss-autopilot/issues/891)
* remove verification checkpoint — always auto-investigate before implementing ([#895](https://github.com/costajohnt/oss-autopilot/issues/895)) ([12e441f](https://github.com/costajohnt/oss-autopilot/commit/12e441f5b21041fae5ba257d6591540ba09952bf)), closes [#887](https://github.com/costajohnt/oss-autopilot/issues/887)

## [1.10.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.9.0...core-v1.10.0) (2026-03-26)


### Features

* add PreToolUse hook to guard git rebase and force-push operations ([#880](https://github.com/costajohnt/oss-autopilot/issues/880)) ([d86a7b7](https://github.com/costajohnt/oss-autopilot/commit/d86a7b732448bcbaaeb991ac469917416293e39b))
* AgentState v3 schema audit, migration, and PR ledger wiring ([#876](https://github.com/costajohnt/oss-autopilot/issues/876)) ([71ae182](https://github.com/costajohnt/oss-autopilot/commit/71ae182cac2f277e063bb226e7d398d51096723a))
* encode maintainer authority and CI-verification rules from OSS contribution lessons ([#882](https://github.com/costajohnt/oss-autopilot/issues/882)) ([3e1e133](https://github.com/costajohnt/oss-autopilot/commit/3e1e1338947ff10e0113724ee3b0d0e5807b0cdf))
* Gist-based persistence layer ([#878](https://github.com/costajohnt/oss-autopilot/issues/878)) ([0519ccc](https://github.com/costajohnt/oss-autopilot/commit/0519ccc4fa1bdcb3f1ceae664970b8f6823aee69))


### Bug Fixes

* add minimal diff discipline to prevent unrelated formatting changes in PRs ([#881](https://github.com/costajohnt/oss-autopilot/issues/881)) ([eafe9cd](https://github.com/costajohnt/oss-autopilot/commit/eafe9cd2a95514b5399d1bb596f60107913a1e1c))
* use real newlines in session-start hook message concatenation ([#879](https://github.com/costajohnt/oss-autopilot/issues/879)) ([23b53a9](https://github.com/costajohnt/oss-autopilot/commit/23b53a92c0d7bed213dca28eeec1895cf3d7d326))

## [1.9.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.8.0...core-v1.9.0) (2026-03-25)


### Features

* add error codes to JSON output envelope ([#865](https://github.com/costajohnt/oss-autopilot/issues/865)) ([7bcd121](https://github.com/costajohnt/oss-autopilot/commit/7bcd121d39b1435cda8c4744a270cc478e947fdb))
* complete setup-automation command implementation ([#870](https://github.com/costajohnt/oss-autopilot/issues/870)) ([52eb480](https://github.com/costajohnt/oss-autopilot/commit/52eb48066d0ee6dee783b4150bd1a731b88121fd)), closes [#849](https://github.com/costajohnt/oss-autopilot/issues/849)
* split issue list into actionable and skipped dedup files ([#873](https://github.com/costajohnt/oss-autopilot/issues/873)) ([1c865e2](https://github.com/costajohnt/oss-autopilot/commit/1c865e21b1f559dbbf1f7392a38703731e9b5889))


### Bug Fixes

* add .mcpregistry token files to .gitignore ([#859](https://github.com/costajohnt/oss-autopilot/issues/859)) ([aea5a86](https://github.com/costajohnt/oss-autopilot/commit/aea5a8646563876bf633b5b1cde0f762f338f26a)), closes [#851](https://github.com/costajohnt/oss-autopilot/issues/851)
* **dashboard:** improve accessibility (a11y) ([#861](https://github.com/costajohnt/oss-autopilot/issues/861)) ([320f376](https://github.com/costajohnt/oss-autopilot/commit/320f37688897c6349f3ce30fe20fb1305fcd04f6))
* run Strategy B search after A+C to avoid rate limiting ([#872](https://github.com/costajohnt/oss-autopilot/issues/872)) ([8e83d90](https://github.com/costajohnt/oss-autopilot/commit/8e83d901cb8832950e5f63a57e68f69d40912b88)), closes [#846](https://github.com/costajohnt/oss-autopilot/issues/846)

## [1.8.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.7.1...core-v1.8.0) (2026-03-25)


### Features

* add /oss-dashboard command to open interactive dashboard ([#844](https://github.com/costajohnt/oss-autopilot/issues/844)) ([639465a](https://github.com/costajohnt/oss-autopilot/commit/639465a376cc2f02f01026a0bdb7b9529e649729))

## [1.7.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.7.0...core-v1.7.1) (2026-03-25)


### Bug Fixes

* reduce GitHub Search API consumption to prevent rate limiting ([#842](https://github.com/costajohnt/oss-autopilot/issues/842)) ([4018a2f](https://github.com/costajohnt/oss-autopilot/commit/4018a2fc7c2418490343e26f8e05489d90c5625b))

## [1.7.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.6.3...core-v1.7.0) (2026-03-24)


### Features

* **dashboard:** add sortable columns to Merged PRs page ([#761](https://github.com/costajohnt/oss-autopilot/issues/761)) ([#841](https://github.com/costajohnt/oss-autopilot/issues/841)) ([e9f00b3](https://github.com/costajohnt/oss-autopilot/commit/e9f00b3f2acfad945986d2ee4f5a6c574e247a5d))
* **dashboard:** display vetted issue list ([#815](https://github.com/costajohnt/oss-autopilot/issues/815)) ([#838](https://github.com/costajohnt/oss-autopilot/issues/838)) ([54ae43b](https://github.com/costajohnt/oss-autopilot/commit/54ae43b527fce702e89b4b345557af1e28fded7e))

## [1.6.3](https://github.com/costajohnt/oss-autopilot/compare/core-v1.6.2...core-v1.6.3) (2026-03-24)


### Bug Fixes

* **mcp-server:** republish with resolved workspace dependency ([#835](https://github.com/costajohnt/oss-autopilot/issues/835)) ([d4e7ee2](https://github.com/costajohnt/oss-autopilot/commit/d4e7ee2239fb795f9db639fd32163755ab3f8462))

## [1.6.2](https://github.com/costajohnt/oss-autopilot/compare/core-v1.6.1...core-v1.6.2) (2026-03-23)


### Bug Fixes

* reuse existing dashboard tab instead of opening a new one ([#830](https://github.com/costajohnt/oss-autopilot/issues/830)) ([#834](https://github.com/costajohnt/oss-autopilot/issues/834)) ([7845e14](https://github.com/costajohnt/oss-autopilot/commit/7845e14caa78317c8c6bcd6fe4fd4bcbf9eb112d))
* skip acknowledgment filter for reviews with inline comments ([#829](https://github.com/costajohnt/oss-autopilot/issues/829)) ([#831](https://github.com/costajohnt/oss-autopilot/issues/831)) ([d018aa4](https://github.com/costajohnt/oss-autopilot/commit/d018aa45c65827474266bb03884f7ee5bf15339b))

## [1.6.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.6.0...core-v1.6.1) (2026-03-22)


### Bug Fixes

* use fetch+reset for marketplace refresh to handle divergent branches ([#827](https://github.com/costajohnt/oss-autopilot/issues/827)) ([254df84](https://github.com/costajohnt/oss-autopilot/commit/254df84d3ca1dd77508d383c685d0887b4e964c8))

## [1.6.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.5.1...core-v1.6.0) (2026-03-22)


### Features

* **badge-endpoint:** add shareable profile widgets ([#818](https://github.com/costajohnt/oss-autopilot/issues/818)) ([37a8136](https://github.com/costajohnt/oss-autopilot/commit/37a8136af492961427f738b4e8e7d20ac1de2217))
* replace LLM dependabot triage with deterministic GitHub Action ([#826](https://github.com/costajohnt/oss-autopilot/issues/826)) ([88ac4ff](https://github.com/costajohnt/oss-autopilot/commit/88ac4ff271acf7f7f4daef5b75a3553dbfc8b58b)), closes [#811](https://github.com/costajohnt/oss-autopilot/issues/811)


### Bug Fixes

* always branch from upstream default, not stale local branches ([#822](https://github.com/costajohnt/oss-autopilot/issues/822)) ([bc727b6](https://github.com/costajohnt/oss-autopilot/commit/bc727b6a665e330023ade4fd06c8632dac7c5728)), closes [#821](https://github.com/costajohnt/oss-autopilot/issues/821)
* auto-investigate issues instead of prompting ([#824](https://github.com/costajohnt/oss-autopilot/issues/824)) ([de205f4](https://github.com/costajohnt/oss-autopilot/commit/de205f49b4f4d1c729f19856c797c1ab11087154))
* defer PR creation until after all review and testing gates ([#823](https://github.com/costajohnt/oss-autopilot/issues/823)) ([bf0d2f8](https://github.com/costajohnt/oss-autopilot/commit/bf0d2f89bfa835f7b31190513df52385816e693b))
* include full GitHub URLs in issue list picker options ([#825](https://github.com/costajohnt/oss-autopilot/issues/825)) ([c2f9f9d](https://github.com/costajohnt/oss-autopilot/commit/c2f9f9d869dddee9c7282ea1ab42b7ab0a951121)), closes [#814](https://github.com/costajohnt/oss-autopilot/issues/814)

## [1.5.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.5.0...core-v1.5.1) (2026-03-21)


### Bug Fixes

* use is:public query to exclude private repos instead of excludeRepos/excludeOrgs ([#807](https://github.com/costajohnt/oss-autopilot/issues/807)) ([198b364](https://github.com/costajohnt/oss-autopilot/commit/198b364e7933395d3ed1823b93790cbef8ba14cf))

## [1.5.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.4.0...core-v1.5.0) (2026-03-21)


### Features

* add /setup-automation command for optional headless cron jobs ([#801](https://github.com/costajohnt/oss-autopilot/issues/801)) ([7f1d876](https://github.com/costajohnt/oss-autopilot/commit/7f1d87665dfd74a716c4f918bafeca52edd8f927))
* add daily PR status cron workflow and SessionStart hook integration ([#800](https://github.com/costajohnt/oss-autopilot/issues/800)) ([44c7888](https://github.com/costajohnt/oss-autopilot/commit/44c7888bafb42e056d6bde9181a58c1b6915514d))
* add headless cron workflow for automated issue list curation ([#797](https://github.com/costajohnt/oss-autopilot/issues/797)) ([90a036b](https://github.com/costajohnt/oss-autopilot/commit/90a036bd0f974c48b36b7e94d447847be5e4ff79)), closes [#784](https://github.com/costajohnt/oss-autopilot/issues/784)
* add headless cron workflow for dependabot PR auto-triage ([#783](https://github.com/costajohnt/oss-autopilot/issues/783)) ([#798](https://github.com/costajohnt/oss-autopilot/issues/798)) ([0a2e848](https://github.com/costajohnt/oss-autopilot/commit/0a2e8481038895191755de1f564091577c3d8032))
* add weekly cron workflow for shelved/waiting PR audit ([#785](https://github.com/costajohnt/oss-autopilot/issues/785)) ([#799](https://github.com/costajohnt/oss-autopilot/issues/799)) ([7c8a79c](https://github.com/costajohnt/oss-autopilot/commit/7c8a79c3a2814a47186ba2ef0c9b527dfa677d51))
* default to skipping PR comments when code speaks for itself ([#795](https://github.com/costajohnt/oss-autopilot/issues/795)) ([dcd88e1](https://github.com/costajohnt/oss-autopilot/commit/dcd88e1ba4701dc67ef472cdeb92aa0f14ddf94f))
* include full clickable repo URLs in search results ([#796](https://github.com/costajohnt/oss-autopilot/issues/796)) ([a3ec8e8](https://github.com/costajohnt/oss-autopilot/commit/a3ec8e8d45b594b82c5dd8c3a21fceb9ab4a792d)), closes [#789](https://github.com/costajohnt/oss-autopilot/issues/789)
* make review-fix convergence loop mandatory before PR readiness ([#794](https://github.com/costajohnt/oss-autopilot/issues/794)) ([fb054f0](https://github.com/costajohnt/oss-autopilot/commit/fb054f0f8021eaf87347328828750d5afa0b714c))
* strengthen claim verification in PR comment drafting ([#788](https://github.com/costajohnt/oss-autopilot/issues/788)) ([#793](https://github.com/costajohnt/oss-autopilot/issues/793)) ([f6bc2f7](https://github.com/costajohnt/oss-autopilot/commit/f6bc2f742275661c0b69fe35672a6e677cfa39ec))
* work on issues before claiming them ([#803](https://github.com/costajohnt/oss-autopilot/issues/803)) ([9301411](https://github.com/costajohnt/oss-autopilot/commit/93014110f2f44c7e2e29ec539dd512edd05b526e))


### Bug Fixes

* exclude private repos and orgs from PR tracking ([#792](https://github.com/costajohnt/oss-autopilot/issues/792)) ([#802](https://github.com/costajohnt/oss-autopilot/issues/802)) ([c0c453a](https://github.com/costajohnt/oss-autopilot/commit/c0c453a8a3dfbce4136c15ae77ae2755404952a2))
* resolve flatted prototype pollution vulnerability ([#804](https://github.com/costajohnt/oss-autopilot/issues/804)) ([4e57fa2](https://github.com/costajohnt/oss-autopilot/commit/4e57fa2956a726376a7b9e75f4f2ba6a233c2d93))

## [1.4.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.3.0...core-v1.4.0) (2026-03-19)


### Features

* mitigate CLI search rate limit failures ([#780](https://github.com/costajohnt/oss-autopilot/issues/780)) ([30b24d7](https://github.com/costajohnt/oss-autopilot/commit/30b24d7dce8f83a95023905c268f9d819cfd7964))

## [1.3.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.2.0...core-v1.3.0) (2026-03-18)


### Features

* add --compact flag to reduce startup JSON payload size ([#770](https://github.com/costajohnt/oss-autopilot/issues/770)) ([5358347](https://github.com/costajohnt/oss-autopilot/commit/535834715d91cfca94972b505df3a259ccde2c7e)), closes [#763](https://github.com/costajohnt/oss-autopilot/issues/763)
* add investigate-before-claim workflow step ([#773](https://github.com/costajohnt/oss-autopilot/issues/773)) ([66e24ec](https://github.com/costajohnt/oss-autopilot/commit/66e24ece9bca43d0310f9524e962f36a183ea94b)), closes [#766](https://github.com/costajohnt/oss-autopilot/issues/766)
* add investigation verification checkpoint before implementation ([#774](https://github.com/costajohnt/oss-autopilot/issues/774)) ([5af0dbc](https://github.com/costajohnt/oss-autopilot/commit/5af0dbc5ab223c08096b105e7f787e6a1e52bb36)), closes [#767](https://github.com/costajohnt/oss-autopilot/issues/767)
* add vet-list command for re-vetting curated issue lists ([#771](https://github.com/costajohnt/oss-autopilot/issues/771)) ([5a5a7fe](https://github.com/costajohnt/oss-autopilot/commit/5a5a7feac66384266e1b1965f2ea7e2e272e9ec9)), closes [#764](https://github.com/costajohnt/oss-autopilot/issues/764)
* default to skip comment when code push addresses feedback ([#775](https://github.com/costajohnt/oss-autopilot/issues/775)) ([e101458](https://github.com/costajohnt/oss-autopilot/commit/e101458575756c711298f8b0fbdc233d8fdac02c)), closes [#768](https://github.com/costajohnt/oss-autopilot/issues/768)
* verify factual accuracy of draft PR comments before presenting ([#776](https://github.com/costajohnt/oss-autopilot/issues/776)) ([c6fbfcf](https://github.com/costajohnt/oss-autopilot/commit/c6fbfcf520688102c02df57513bc693cae836838)), closes [#769](https://github.com/costajohnt/oss-autopilot/issues/769)
* warn when claiming issues while at PR capacity limit ([#772](https://github.com/costajohnt/oss-autopilot/issues/772)) ([2bd87c9](https://github.com/costajohnt/oss-autopilot/commit/2bd87c90bb74b91eb62005c7bc451e6702a6400f)), closes [#765](https://github.com/costajohnt/oss-autopilot/issues/765)

## [1.2.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.1.0...core-v1.2.0) (2026-03-16)


### Features

* add configurable scoreThreshold for vetted issue filtering ([#759](https://github.com/costajohnt/oss-autopilot/issues/759)) ([600b801](https://github.com/costajohnt/oss-autopilot/commit/600b801b4c6c1b850035a12a2a6953c93169a439))

## [1.1.0](https://github.com/costajohnt/oss-autopilot/compare/core-v1.0.1...core-v1.1.0) (2026-03-16)


### Features

* add clickable GitHub links to repo/PR/issue references in plugin UI ([#757](https://github.com/costajohnt/oss-autopilot/issues/757)) ([8a76147](https://github.com/costajohnt/oss-autopilot/commit/8a76147822919a0602104e311f39ef5e9878d404))

## [1.0.1](https://github.com/costajohnt/oss-autopilot/compare/core-v1.0.0...core-v1.0.1) (2026-03-15)


### Bug Fixes

* chunk GitHub Search queries to stay within 5 boolean operator limit ([#754](https://github.com/costajohnt/oss-autopilot/issues/754)) ([3c1a3eb](https://github.com/costajohnt/oss-autopilot/commit/3c1a3ebde8096016c5a821b7afbddd87bf383f45))
* reconcile repoScores PR counts with stored arrays ([#756](https://github.com/costajohnt/oss-autopilot/issues/756)) ([a369cc6](https://github.com/costajohnt/oss-autopilot/commit/a369cc6ba838d9ec0bd133a1e48ddfaec4c311b1))
* update docs with missing badge-endpoint package and oss-help command ([#749](https://github.com/costajohnt/oss-autopilot/issues/749)) ([6148cfb](https://github.com/costajohnt/oss-autopilot/commit/6148cfb59274773b6a06ce0c113a6ee7b6c87acf))

## [1.0.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.60.1...core-v1.0.0) (2026-03-12)


### ⚠ BREAKING CHANGES

* ship 1.0.0 — stability policy and semver commitment ([#746](https://github.com/costajohnt/oss-autopilot/issues/746))

### Features

* ship 1.0.0 — stability policy and semver commitment ([#746](https://github.com/costajohnt/oss-autopilot/issues/746)) ([f1b2ab0](https://github.com/costajohnt/oss-autopilot/commit/f1b2ab04e7034aa788f55827d961de5270d58319)), closes [#667](https://github.com/costajohnt/oss-autopilot/issues/667)

## [0.60.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.60.0...core-v0.60.1) (2026-03-12)


### Bug Fixes

* classify action_required checks and RTD failures as non-actionable ([#744](https://github.com/costajohnt/oss-autopilot/issues/744)) ([930ff41](https://github.com/costajohnt/oss-autopilot/commit/930ff415330f590d0648b2e2926c41c5092dec73))

## [0.60.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.59.0...core-v0.60.0) (2026-03-12)


### Features

* add runtime schema validation for state.json deserialization ([#738](https://github.com/costajohnt/oss-autopilot/issues/738)) ([b33a258](https://github.com/costajohnt/oss-autopilot/commit/b33a25888b9b2e3e72d5f2088ce0434861245ccf))


### Bug Fixes

* update hono pnpm override to &gt;=4.12.7 (GHSA-v8w9-8mx6-g223) ([#733](https://github.com/costajohnt/oss-autopilot/issues/733)) ([5ce12eb](https://github.com/costajohnt/oss-autopilot/commit/5ce12ebbc585fa4feeae361e741f141f9f5b11a2)), closes [#725](https://github.com/costajohnt/oss-autopilot/issues/725)

## [0.59.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.58.0...core-v0.59.0) (2026-03-11)


### Features

* add CI performance benchmarks for CLI startup ([#628](https://github.com/costajohnt/oss-autopilot/issues/628)) ([#718](https://github.com/costajohnt/oss-autopilot/issues/718)) ([1dc4cec](https://github.com/costajohnt/oss-autopilot/commit/1dc4cec65e2ed8e10d1df7de868faf90177e045a))
* add formatter detection CLI module ([#703](https://github.com/costajohnt/oss-autopilot/issues/703)) ([#708](https://github.com/costajohnt/oss-autopilot/issues/708)) ([ddfb36a](https://github.com/costajohnt/oss-autopilot/commit/ddfb36ad49f8a6fcec297b92a80a3eae12c053f2))
* add TypeDoc API documentation with JSDoc coverage ([#717](https://github.com/costajohnt/oss-autopilot/issues/717)) ([89516aa](https://github.com/costajohnt/oss-autopilot/commit/89516aa7ea920bc65e93be7f766ce2df12a1ef48))
* **dashboard:** redesign merged & closed PR pages as full-width tables ([#706](https://github.com/costajohnt/oss-autopilot/issues/706)) ([f62d5a2](https://github.com/costajohnt/oss-autopilot/commit/f62d5a28582744fa29fb676dd4a0dbbb5d91e4ee))


### Bug Fixes

* detect source file changes in startup builds and add scope tier to setup wizard ([#704](https://github.com/costajohnt/oss-autopilot/issues/704)) ([a34293d](https://github.com/costajohnt/oss-autopilot/commit/a34293deac996b4b55e69554f01f15f64fcec685))
* pass excludeRepos and excludeOrgs to issue-scout agent strategies ([#709](https://github.com/costajohnt/oss-autopilot/issues/709)) ([#711](https://github.com/costajohnt/oss-autopilot/issues/711)) ([9622051](https://github.com/costajohnt/oss-autopilot/commit/9622051d2df830d36dfe64194662dd1222a93a7b))

## [0.58.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.57.0...core-v0.58.0) (2026-03-10)


### Features

* add light-mode hero banner SVG for README ([#701](https://github.com/costajohnt/oss-autopilot/issues/701)) ([77777ca](https://github.com/costajohnt/oss-autopilot/commit/77777ca9c1fbb5c32c7f1e72c05f1b3d6a06e707))

## [0.57.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.56.0...core-v0.57.0) (2026-03-10)


### Features

* **dashboard:** add light mode theme with toggle ([#699](https://github.com/costajohnt/oss-autopilot/issues/699)) ([65f7815](https://github.com/costajohnt/oss-autopilot/commit/65f7815e7e8329813062e6a7026c29dcd2a50a7c))


### Bug Fixes

* **badge:** prevent intermittent "inaccessible" on shields.io badge ([#693](https://github.com/costajohnt/oss-autopilot/issues/693)) ([98f2fc3](https://github.com/costajohnt/oss-autopilot/commit/98f2fc32a261d24373f8cc76ab0d3f968932daf6))

## [0.56.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.55.0...core-v0.56.0) (2026-03-10)


### Features

* **dashboard:** complete UI redesign with new design system ([#694](https://github.com/costajohnt/oss-autopilot/issues/694)) ([bc56efc](https://github.com/costajohnt/oss-autopilot/commit/bc56efc61dbf1e63ef9e2f975a2079da76f8d989))

## [0.55.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.54.0...core-v0.55.0) (2026-03-10)


### Features

* **dashboard:** UI polish with animations and colored stats ([#688](https://github.com/costajohnt/oss-autopilot/issues/688)) ([119b093](https://github.com/costajohnt/oss-autopilot/commit/119b093e965c1eaaf7e7965df062463481908b3d))
* expand issue discovery with scope tiers and fix OR-join bug ([#684](https://github.com/costajohnt/oss-autopilot/issues/684)) ([4ef831a](https://github.com/costajohnt/oss-autopilot/commit/4ef831a0b38aa2d6b866b2bad124091ad1713ea3)), closes [#683](https://github.com/costajohnt/oss-autopilot/issues/683)


### Bug Fixes

* correct health-check counts and expand dashboard search scope ([#681](https://github.com/costajohnt/oss-autopilot/issues/681)) ([b5c6b8d](https://github.com/costajohnt/oss-autopilot/commit/b5c6b8d9e17c03adc3fbbb8df2a88e6664eda568))

## [0.54.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.53.1...core-v0.54.0) (2026-03-09)


### Features

* **dashboard:** show repo stars and language on merged PRs page ([#678](https://github.com/costajohnt/oss-autopilot/issues/678)) ([79146ce](https://github.com/costajohnt/oss-autopilot/commit/79146ce44535a32a2d7a9c553fda1de2cce4165a))


### Bug Fixes

* reduce over-classification of PRs as needs_addressing ([#680](https://github.com/costajohnt/oss-autopilot/issues/680)) ([55458df](https://github.com/costajohnt/oss-autopilot/commit/55458df8c9d2bee19b36463874e58c6d8a79f04b))

## [0.53.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.53.0...core-v0.53.1) (2026-03-09)


### Bug Fixes

* **ci:** build core types before recording bundle sizes in update-badge job ([#672](https://github.com/costajohnt/oss-autopilot/issues/672)) ([f2ebb01](https://github.com/costajohnt/oss-autopilot/commit/f2ebb01be2baf09e99c145c2ba6671530e18cb1e))

## [0.53.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.52.0...core-v0.53.0) (2026-03-09)


### Features

* **ci:** add bundle size tracking and regression detection ([#669](https://github.com/costajohnt/oss-autopilot/issues/669)) ([7f968c8](https://github.com/costajohnt/oss-autopilot/commit/7f968c847b9e5d6073412e4b7fb633bd0eea21fd))

## [0.52.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.51.1...core-v0.52.0) (2026-03-08)


### Features

* **badge:** filter to external repos with configurable star threshold ([#662](https://github.com/costajohnt/oss-autopilot/issues/662)) ([574d9fa](https://github.com/costajohnt/oss-autopilot/commit/574d9facd3eacedfcb2c9a31491d61e2e7274ff9))

## [0.51.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.51.0...core-v0.51.1) (2026-03-08)


### Bug Fixes

* dashboard stale state and aggressive rate limit ([#660](https://github.com/costajohnt/oss-autopilot/issues/660)) ([c5ac66a](https://github.com/costajohnt/oss-autopilot/commit/c5ac66a08e57503c1ea9cb5a71cba7b7b4b4d2bd))

## [0.51.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.50.0...core-v0.51.0) (2026-03-08)


### ⚠ BREAKING CHANGES

* Removed `snooze` and `unsnooze` tools. Use `move` with target `attention`, `waiting`, `shelved`, or `auto` instead. Dismiss now only accepts issue URLs.

### Features

* simplify PR management to three-state model ([#657](https://github.com/costajohnt/oss-autopilot/issues/657)) ([abe7705](https://github.com/costajohnt/oss-autopilot/commit/abe770556eb190fc6769abfecea46f0c744f6793))

## [0.50.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.49.0...core-v0.50.0) (2026-03-08)


### Features

* add project category preferences to setup & search ([#655](https://github.com/costajohnt/oss-autopilot/issues/655)) ([84d850e](https://github.com/costajohnt/oss-autopilot/commit/84d850ef4ae5967ce5a8cf8f95f6b1a04a526bef))
* **dashboard:** dismissable issue response items ([#654](https://github.com/costajohnt/oss-autopilot/issues/654)) ([63463b4](https://github.com/costajohnt/oss-autopilot/commit/63463b467c5c51c8b66dba1e7414e68af46d5c86))


### Bug Fixes

* use singular phrasing in action menu for single issue ([#652](https://github.com/costajohnt/oss-autopilot/issues/652)) ([ca94b02](https://github.com/costajohnt/oss-autopilot/commit/ca94b02907c5eff2f24852f459bf05248834040c))

## [0.49.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.48.0...core-v0.49.0) (2026-03-08)


### Features

* expose isNewContribution flag in CLI JSON output ([#650](https://github.com/costajohnt/oss-autopilot/issues/650)) ([61e2309](https://github.com/costajohnt/oss-autopilot/commit/61e230902bbd81e2c48de0a9219730351c4ba2de))


### Bug Fixes

* align dashboard terminology from "Action Required" to "Need Attention" ([#645](https://github.com/costajohnt/oss-autopilot/issues/645)) ([#648](https://github.com/costajohnt/oss-autopilot/issues/648)) ([e4e917a](https://github.com/costajohnt/oss-autopilot/commit/e4e917af1cbcce6f918d358292e95c5d2b6c261c))
* CLI respects dashboard PR status overrides ([#644](https://github.com/costajohnt/oss-autopilot/issues/644)) ([#646](https://github.com/costajohnt/oss-autopilot/issues/646)) ([41aa546](https://github.com/costajohnt/oss-autopilot/commit/41aa5467c00999c87ae3fc86995f5cb4d187f4ca))

## [0.48.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.47.2...core-v0.48.0) (2026-03-08)


### Features

* clickable closed PR count with detail view ([#642](https://github.com/costajohnt/oss-autopilot/issues/642)) ([2706019](https://github.com/costajohnt/oss-autopilot/commit/27060190957c7a1e5da7230f7c5b6a82d8bf3e06))

## [0.47.2](https://github.com/costajohnt/oss-autopilot/compare/core-v0.47.1...core-v0.47.2) (2026-03-08)


### Bug Fixes

* filter merged PRs by minStars + auto-refresh dashboard on mount ([#640](https://github.com/costajohnt/oss-autopilot/issues/640)) ([c8d7314](https://github.com/costajohnt/oss-autopilot/commit/c8d7314a9d1265e2d788c2b66986a1fd6eec35df))

## [0.47.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.47.0...core-v0.47.1) (2026-03-08)


### Bug Fixes

* auto-refresh marketplace cache on session start ([#638](https://github.com/costajohnt/oss-autopilot/issues/638)) ([f4d8469](https://github.com/costajohnt/oss-autopilot/commit/f4d846926f90bbd89ef11ed9af81173923bfeb49))

## [0.47.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.46.2...core-v0.47.0) (2026-03-08)


### Features

* add clickable merged PR count with detail view ([#633](https://github.com/costajohnt/oss-autopilot/issues/633)) ([#636](https://github.com/costajohnt/oss-autopilot/issues/636)) ([586aaed](https://github.com/costajohnt/oss-autopilot/commit/586aaed245527ba1d2386ad226029db86d347e89))

## [0.46.2](https://github.com/costajohnt/oss-autopilot/compare/core-v0.46.1...core-v0.46.2) (2026-03-07)


### Bug Fixes

* resolve MCP server npm dependency resolution failures ([#630](https://github.com/costajohnt/oss-autopilot/issues/630)) ([72567d0](https://github.com/costajohnt/oss-autopilot/commit/72567d0b233ff2ca268c39a709186a4ab5b435d2))

## [0.46.1](https://github.com/costajohnt/oss-autopilot/compare/core-v0.46.0...core-v0.46.1) (2026-03-07)


### Bug Fixes

* remove unrecognized "icon" key from plugin manifest ([#610](https://github.com/costajohnt/oss-autopilot/issues/610)) ([cd61fe7](https://github.com/costajohnt/oss-autopilot/commit/cd61fe77a6cdd8355205ab951207b72d112dc172))

## [0.46.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.45.0...core-v0.46.0) (2026-03-07)


### Features

* add rate limiting to dashboard server API endpoints ([#609](https://github.com/costajohnt/oss-autopilot/issues/609)) ([4a8ae98](https://github.com/costajohnt/oss-autopilot/commit/4a8ae98f74fb0ea01f4b5bbef72e3ffb630a59f9)), closes [#603](https://github.com/costajohnt/oss-autopilot/issues/603)


### Bug Fixes

* remove legacy HTML dashboard from core package ([#605](https://github.com/costajohnt/oss-autopilot/issues/605)) ([d2dc67f](https://github.com/costajohnt/oss-autopilot/commit/d2dc67f9e6fddfba10171aaeb0b876643b383c17)), closes [#599](https://github.com/costajohnt/oss-autopilot/issues/599)

## [0.45.0](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.18...core-v0.45.0) (2026-03-07)


### Features

* detect and use repository PR templates when creating PRs ([#595](https://github.com/costajohnt/oss-autopilot/issues/595)) ([fa0a5da](https://github.com/costajohnt/oss-autopilot/commit/fa0a5da102b40f54a8db2b40e251d46802727995))
* zero-config first run and shareable contribution stats ([#592](https://github.com/costajohnt/oss-autopilot/issues/592)) ([779f4b2](https://github.com/costajohnt/oss-autopilot/commit/779f4b255c803bbf31119548ec382b6901a52301))


### Bug Fixes

* resolve TypeScript discriminated union error in pr-template ([#596](https://github.com/costajohnt/oss-autopilot/issues/596)) ([01c4095](https://github.com/costajohnt/oss-autopilot/commit/01c4095fe9427a8099e401f934ad50e78bf018fe))
* scope excludeRepos to issue discovery only ([#594](https://github.com/costajohnt/oss-autopilot/issues/594)) ([9fc2fda](https://github.com/costajohnt/oss-autopilot/commit/9fc2fda303706b46529fa3a81d23d8b64ad277fc))

## [0.44.18](https://github.com/costajohnt/oss-autopilot/compare/core-v0.44.17...core-v0.44.18) (2026-03-06)


### Bug Fixes

* remove git hooks before badges branch checkout ([#587](https://github.com/costajohnt/oss-autopilot/issues/587)) ([c605fc1](https://github.com/costajohnt/oss-autopilot/commit/c605fc1e8c7d0d3e320d2fd31905af5d1a3215e8))

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
