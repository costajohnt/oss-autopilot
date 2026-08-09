# Changelog

## [5.7.2](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.7.1...mcp-v5.7.2) (2026-08-08)

No functional change to the MCP server.

This version was published as a side effect of release tooling. An empty
`fix(deps):` commit ([#1609](https://github.com/costajohnt/oss-autopilot/issues/1609))
was created to mark the `@oss-scout/core` bump in `@oss-autopilot/core` as
releasable. Having no file paths, it could not be attributed by path, and
release-please assigned it to this package instead. The entry previously shown
here credited that bump to `@oss-autopilot/mcp`, which does not depend on
`@oss-scout/core` — only `@oss-autopilot/core` does.

The bump was subsequently re-landed correctly and shipped in
`@oss-autopilot/core` 3.20.2 ([#1612](https://github.com/costajohnt/oss-autopilot/issues/1612)).

## [5.7.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.7.0...mcp-v5.7.1) (2026-07-15)


### Bug Fixes

* raise bare search default from 5 to 15 so broad/maintained phases can run ([#1572](https://github.com/costajohnt/oss-autopilot/issues/1572)) ([4962160](https://github.com/costajohnt/oss-autopilot/commit/496216057da8ea043c4953d50592cadb47c40c76))

## [5.7.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.6.3...mcp-v5.7.0) (2026-06-16)


### Features

* **repo-vet:** name both repo scores; merge the scoring docs ([#1465](https://github.com/costajohnt/oss-autopilot/issues/1465)) ([#1482](https://github.com/costajohnt/oss-autopilot/issues/1482)) ([f52ad4d](https://github.com/costajohnt/oss-autopilot/commit/f52ad4d9114385fbb08d0f4c241357227d4f669b))


### Bug Fixes

* **mcp:** reload state per tool call and keep repair tools usable on hard gist-init errors ([#1439](https://github.com/costajohnt/oss-autopilot/issues/1439), [#1441](https://github.com/costajohnt/oss-autopilot/issues/1441)) ([#1471](https://github.com/costajohnt/oss-autopilot/issues/1471)) ([4820fc2](https://github.com/costajohnt/oss-autopilot/commit/4820fc2ff98ca55ff2fa9c4cb4e8c5b8cb76465e))
* **security:** fence titles on MCP surfaces; label guidelines provenance; pin the posts-guard matcher ([#1455](https://github.com/costajohnt/oss-autopilot/issues/1455)) ([#1493](https://github.com/costajohnt/oss-autopilot/issues/1493)) ([a4bb7d4](https://github.com/costajohnt/oss-autopilot/commit/a4bb7d493cb78013fe1269093f21f2e3e3e4823d))
* **state:** report and recover the gist-degraded bootstrap honestly ([#1443](https://github.com/costajohnt/oss-autopilot/issues/1443)) ([#1492](https://github.com/costajohnt/oss-autopilot/issues/1492)) ([c43b2c5](https://github.com/costajohnt/oss-autopilot/commit/c43b2c59ffbf3b1cfb9656a9ffff16fd7b354073))

## [5.6.3](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.6.2...mcp-v5.6.3) (2026-06-12)


### Bug Fixes

* **core,mcp:** close gist-degradation gaps outside the MCP tool path ([#1434](https://github.com/costajohnt/oss-autopilot/issues/1434)) ([d8dff08](https://github.com/costajohnt/oss-autopilot/commit/d8dff08a5de15c0cc8fc91d090a03aa925f0ecdb)), closes [#1431](https://github.com/costajohnt/oss-autopilot/issues/1431)

## [5.6.2](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.6.1...mcp-v5.6.2) (2026-06-12)


### Bug Fixes

* **core,mcp:** transient gist-init failures retry instead of silently latching local-only ([#1430](https://github.com/costajohnt/oss-autopilot/issues/1430)) ([9e6c5c9](https://github.com/costajohnt/oss-autopilot/commit/9e6c5c98785fe4d103abd12c4a97bd6b3e2de6af)), closes [#1415](https://github.com/costajohnt/oss-autopilot/issues/1415)

## [5.6.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.6.0...mcp-v5.6.1) (2026-06-12)


### Bug Fixes

* **security:** fence lastMaintainerComment.body at agent-facing boundaries ([#1427](https://github.com/costajohnt/oss-autopilot/issues/1427)) ([6707ecf](https://github.com/costajohnt/oss-autopilot/commit/6707ecf046ae1e347ca3b857fcaf9223e76a37b5)), closes [#1420](https://github.com/costajohnt/oss-autopilot/issues/1420)

## [5.6.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.5.0...mcp-v5.6.0) (2026-06-11)


### Features

* **core,mcp:** deterministic verify-issue — state, stateReason, and linked-PR claim classification ([#1409](https://github.com/costajohnt/oss-autopilot/issues/1409)) ([107150b](https://github.com/costajohnt/oss-autopilot/commit/107150b72fe68a1ec865578b660a1694111dc231))

## [5.5.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.4.0...mcp-v5.5.0) (2026-06-11)


### Features

* **guidelines:** add guidelines list subcommand and MCP tool ([#1400](https://github.com/costajohnt/oss-autopilot/issues/1400)) ([085e127](https://github.com/costajohnt/oss-autopilot/commit/085e127f9b7c6e07bab814aad10b4a97eb5def99)), closes [#1393](https://github.com/costajohnt/oss-autopilot/issues/1393)
* **security:** wire the untrusted-content fence into agent-facing output ([#1396](https://github.com/costajohnt/oss-autopilot/issues/1396)) ([e1599a0](https://github.com/costajohnt/oss-autopilot/commit/e1599a0018f82282620130402829686d775a125a)), closes [#1372](https://github.com/costajohnt/oss-autopilot/issues/1372)


### Bug Fixes

* **mcp:** retry Gist init after transient failure instead of latching done ([#1383](https://github.com/costajohnt/oss-autopilot/issues/1383)) ([924aff0](https://github.com/costajohnt/oss-autopilot/commit/924aff0a245b8ef43bd48efbabf5142c26b7c385)), closes [#1368](https://github.com/costajohnt/oss-autopilot/issues/1368)

## [5.4.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.3.1...mcp-v5.4.0) (2026-05-18)


### Features

* **strategy:** expose on-demand snapshot via CLI/MCP, rewire agent ([#1243](https://github.com/costajohnt/oss-autopilot/issues/1243) step 4) ([#1348](https://github.com/costajohnt/oss-autopilot/issues/1348)) ([912c0b4](https://github.com/costajohnt/oss-autopilot/commit/912c0b4a7eae7324a0270003d4f7634eaaf5d9b2))

## [5.3.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.3.0...mcp-v5.3.1) (2026-05-10)


### Bug Fixes

* **test:** stop mcp-server tools test from writing to real state.json ([#1343](https://github.com/costajohnt/oss-autopilot/issues/1343)) ([f0d284c](https://github.com/costajohnt/oss-autopilot/commit/f0d284c8e6212328d98a06621321af4a174e428d))

## [5.3.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.2.0...mcp-v5.3.0) (2026-05-10)


### Features

* integrate @oss-scout/core 0.9.0 (features command + stalled-PR detection) ([#1338](https://github.com/costajohnt/oss-autopilot/issues/1338)) ([4af41fc](https://github.com/costajohnt/oss-autopilot/commit/4af41fcde9acc545aa62f63c5b0255480e393ea8))

## [5.2.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.1.2...mcp-v5.2.0) (2026-05-08)


### Features

* add repo-vet MCP tool ([#1271](https://github.com/costajohnt/oss-autopilot/issues/1271) step 2) ([#1319](https://github.com/costajohnt/oss-autopilot/issues/1319)) ([4b80529](https://github.com/costajohnt/oss-autopilot/commit/4b80529c9f99ea1e0bd8cba9acc016a5dc91e36a))


### Bug Fixes

* pr-compliance-checker `read` ref + extract-to-core ([#1245](https://github.com/costajohnt/oss-autopilot/issues/1245)) ([#1258](https://github.com/costajohnt/oss-autopilot/issues/1258)) ([7d4337c](https://github.com/costajohnt/oss-autopilot/commit/7d4337c34fd7d42e6c336fb40d1fed6b76ceb3c9))

## [5.1.2](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.1.1...mcp-v5.1.2) (2026-05-07)


### Bug Fixes

* **validation:** reject octocat and monalisa as placeholder usernames ([#1240](https://github.com/costajohnt/oss-autopilot/issues/1240)) ([14f9d98](https://github.com/costajohnt/oss-autopilot/commit/14f9d98efdd774ce186e1c9d2f6e6095bbc206a8))

## [5.1.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.1.0...mcp-v5.1.1) (2026-05-06)


### Bug Fixes

* **mcp:** throw on prompt failures instead of returning userMessage ([#1203](https://github.com/costajohnt/oss-autopilot/issues/1203)) ([#1217](https://github.com/costajohnt/oss-autopilot/issues/1217)) ([85a20bc](https://github.com/costajohnt/oss-autopilot/commit/85a20bcfa115feae1834e15c058d5c358aa4c60e))

## [5.1.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.0.1...mcp-v5.1.0) (2026-04-26)


### Features

* **mcp:** add guidelines tools + extract-learnings prompt + repo-guidelines resource ([#867](https://github.com/costajohnt/oss-autopilot/issues/867) PR 5) ([#1176](https://github.com/costajohnt/oss-autopilot/issues/1176)) ([b476d23](https://github.com/costajohnt/oss-autopilot/commit/b476d23bdaca70374336af127332abea0b08a117))

## [5.0.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.0.0...mcp-v5.0.1) (2026-04-26)


### Performance Improvements

* **mcp:** cite load-test data on per-request createServer pattern ([#1167](https://github.com/costajohnt/oss-autopilot/issues/1167)) ([b4a4fd2](https://github.com/costajohnt/oss-autopilot/commit/b4a4fd22c56d755e748795db5d01b27ebe08f0d0))

## [5.0.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v4.0.0...mcp-v5.0.0) (2026-04-26)


### ⚠ BREAKING CHANGES

* users on Node 20 will see npm EBADENGINE warnings on install. Upgrade to Node 22 (LTS) or 24 (current) before pulling this release.

### Features

* drop Node 20 support, require Node 22+ ([#1162](https://github.com/costajohnt/oss-autopilot/issues/1162)) ([f88a064](https://github.com/costajohnt/oss-autopilot/commit/f88a0647c0bf7df295442b7615e1a9e131152b14))

## [4.0.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.1.4...mcp-v4.0.0) (2026-04-25)


### ⚠ BREAKING CHANGES

* the MCP tools `read` and `untrack` are no longer registered. Clients that hard-coded these tool names will get a "tool not found" error from listTools / callTool. The CLI commands of the same name are also removed; scripts that invoked them get "unknown command" from commander.

### Features

* remove read/untrack v1 stubs from CLI and MCP server ([#1133](https://github.com/costajohnt/oss-autopilot/issues/1133)) ([#1157](https://github.com/costajohnt/oss-autopilot/issues/1157)) ([a957feb](https://github.com/costajohnt/oss-autopilot/commit/a957febd0341c447a4e4f735b83d086c025b0694))

## [3.1.4](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.1.3...mcp-v3.1.4) (2026-04-22)


### Bug Fixes

* close UM4 dashboard SPA + MCP polish findings M37/M38/M39/M40/M41 ([#1094](https://github.com/costajohnt/oss-autopilot/issues/1094)) ([076c00f](https://github.com/costajohnt/oss-autopilot/commit/076c00f4d85daaf095b42415fbb96c9bcf5abfc8))
* **mcp:** align README and server.json with reality ([#1065](https://github.com/costajohnt/oss-autopilot/issues/1065)) ([414cd14](https://github.com/costajohnt/oss-autopilot/commit/414cd14050c9565507ce5939f41a8fee517a92d3))
* **mcp:** bearer-token auth for HTTP transport ([#1028](https://github.com/costajohnt/oss-autopilot/issues/1028)) ([#1068](https://github.com/costajohnt/oss-autopilot/issues/1068)) ([d6f0a54](https://github.com/costajohnt/oss-autopilot/commit/d6f0a545689b776348fa91dfbee6f27fb916992a))
* **mcp:** destructive hints + URL validation + config-key enum ([#1053](https://github.com/costajohnt/oss-autopilot/issues/1053)) ([#1089](https://github.com/costajohnt/oss-autopilot/issues/1089)) ([5c70a8e](https://github.com/costajohnt/oss-autopilot/commit/5c70a8e2a59aefdb69772f3fee479abe8c1cc278))

## [3.1.3](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.1.2...mcp-v3.1.3) (2026-04-19)


### Bug Fixes

* **mcp:** propagate resource errors as JSON-RPC errors instead of 200 OK payloads ([#957](https://github.com/costajohnt/oss-autopilot/issues/957)) ([#970](https://github.com/costajohnt/oss-autopilot/issues/970)) ([900f437](https://github.com/costajohnt/oss-autopilot/commit/900f43750a7fabbd532b53729b4721c3b4508b75))

## [3.1.2](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.1.1...mcp-v3.1.2) (2026-04-01)


### Bug Fixes

* address comprehensive repo audit findings ([#918](https://github.com/costajohnt/oss-autopilot/issues/918)) ([bce859c](https://github.com/costajohnt/oss-autopilot/commit/bce859cb19a58b88526d75ad809f6b8c72909be3))

## [3.1.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.1.0...mcp-v3.1.1) (2026-03-30)


### Bug Fixes

* update agents, add vet-list to MCP, map excludeOrgs ([#905](https://github.com/costajohnt/oss-autopilot/issues/905)) ([822bdea](https://github.com/costajohnt/oss-autopilot/commit/822bdea29d52bf1033f37242daf850fe680b4a82))

## [3.1.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v3.0.0...mcp-v3.1.0) (2026-03-27)


### Features

* activate Gist persistence layer with opt-in setup, scope check, dashboard refresh, and unlink ([#885](https://github.com/costajohnt/oss-autopilot/issues/885)) ([2a1de39](https://github.com/costajohnt/oss-autopilot/commit/2a1de397660cc85a533ae8a9434d3cb0e13356ab)), closes [#883](https://github.com/costajohnt/oss-autopilot/issues/883)

## [3.0.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v2.0.2...mcp-v3.0.0) (2026-03-24)


### ⚠ BREAKING CHANGES

* Removed `snooze` and `unsnooze` tools. Use `move` with target `attention`, `waiting`, `shelved`, or `auto` instead. Dismiss now only accepts issue URLs.

### Features

* add MCP server package (Phase 4) ([#429](https://github.com/costajohnt/oss-autopilot/issues/429)) ([ca336be](https://github.com/costajohnt/oss-autopilot/commit/ca336be7df44bfdc758d00a8e88719159f5cf894))
* simplify PR management to three-state model ([#657](https://github.com/costajohnt/oss-autopilot/issues/657)) ([abe7705](https://github.com/costajohnt/oss-autopilot/commit/abe770556eb190fc6769abfecea46f0c744f6793))


### Bug Fixes

* address all open repo audit findings ([#547](https://github.com/costajohnt/oss-autopilot/issues/547)-[#553](https://github.com/costajohnt/oss-autopilot/issues/553)) ([#555](https://github.com/costajohnt/oss-autopilot/issues/555)) ([4b98a5c](https://github.com/costajohnt/oss-autopilot/commit/4b98a5c6771e1504b6237ff6ea38807c075f62f5))
* dismiss command accepts PR URLs and filters them from actionable items ([#416](https://github.com/costajohnt/oss-autopilot/issues/416)) ([#464](https://github.com/costajohnt/oss-autopilot/issues/464)) ([20f6f3c](https://github.com/costajohnt/oss-autopilot/commit/20f6f3cec5c47a6e0524679dfd8f82377690c89a))
* exclude own repos from PR counts and filter by star count ([#544](https://github.com/costajohnt/oss-autopilot/issues/544)) ([12eeeaa](https://github.com/costajohnt/oss-autopilot/commit/12eeeaa5a7ebc369714f9c880d5f39a6ff3f8fa7))
* **mcp-server:** republish with resolved workspace dependency ([#835](https://github.com/costajohnt/oss-autopilot/issues/835)) ([d4e7ee2](https://github.com/costajohnt/oss-autopilot/commit/d4e7ee2239fb795f9db639fd32163755ab3f8462))
* resolve MCP server npm dependency resolution failures ([#630](https://github.com/costajohnt/oss-autopilot/issues/630)) ([72567d0](https://github.com/costajohnt/oss-autopilot/commit/72567d0b233ff2ca268c39a709186a4ab5b435d2))

## [2.0.0](https://github.com/costajohnt/oss-autopilot/compare/mcp-v1.0.4...mcp-v2.0.0) (2026-03-08)


### ⚠ BREAKING CHANGES

* Removed `snooze` and `unsnooze` tools. Use `move` with target `attention`, `waiting`, `shelved`, or `auto` instead. Dismiss now only accepts issue URLs.

### Features

* simplify PR management to three-state model ([#657](https://github.com/costajohnt/oss-autopilot/issues/657)) ([abe7705](https://github.com/costajohnt/oss-autopilot/commit/abe770556eb190fc6769abfecea46f0c744f6793))

## [1.0.4](https://github.com/costajohnt/oss-autopilot/compare/mcp-v1.0.3...mcp-v1.0.4) (2026-03-07)


### Bug Fixes

* resolve MCP server npm dependency resolution failures ([#630](https://github.com/costajohnt/oss-autopilot/issues/630)) ([72567d0](https://github.com/costajohnt/oss-autopilot/commit/72567d0b233ff2ca268c39a709186a4ab5b435d2))

## [1.0.3](https://github.com/costajohnt/oss-autopilot/compare/mcp-v1.0.2...mcp-v1.0.3) (2026-03-05)


### Bug Fixes

* address all open repo audit findings ([#547](https://github.com/costajohnt/oss-autopilot/issues/547)-[#553](https://github.com/costajohnt/oss-autopilot/issues/553)) ([#555](https://github.com/costajohnt/oss-autopilot/issues/555)) ([4b98a5c](https://github.com/costajohnt/oss-autopilot/commit/4b98a5c6771e1504b6237ff6ea38807c075f62f5))

## [1.0.2](https://github.com/costajohnt/oss-autopilot/compare/mcp-v1.0.1...mcp-v1.0.2) (2026-03-04)


### Bug Fixes

* exclude own repos from PR counts and filter by star count ([#544](https://github.com/costajohnt/oss-autopilot/issues/544)) ([12eeeaa](https://github.com/costajohnt/oss-autopilot/commit/12eeeaa5a7ebc369714f9c880d5f39a6ff3f8fa7))

## [1.0.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v1.0.0...mcp-v1.0.1) (2026-03-02)


### Bug Fixes

* dismiss command accepts PR URLs and filters them from actionable items ([#416](https://github.com/costajohnt/oss-autopilot/issues/416)) ([#464](https://github.com/costajohnt/oss-autopilot/issues/464)) ([20f6f3c](https://github.com/costajohnt/oss-autopilot/commit/20f6f3cec5c47a6e0524679dfd8f82377690c89a))

## 1.0.0 (2026-03-02)


### Features

* add MCP server package (Phase 4) ([#429](https://github.com/costajohnt/oss-autopilot/issues/429)) ([ca336be](https://github.com/costajohnt/oss-autopilot/commit/ca336be7df44bfdc758d00a8e88719159f5cf894))
