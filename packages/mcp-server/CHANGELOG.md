# Changelog

## [5.1.1](https://github.com/costajohnt/oss-autopilot/compare/mcp-v5.1.0...mcp-v5.1.1) (2026-05-06)


### Bug Fixes

* **mcp:** throw on prompt failures instead of returning userMessage ([#1203](https://github.com/costajohnt/oss-autopilot/issues/1203)) ([#1217](https://github.com/costajohnt/oss-autopilot/issues/1217)) ([85a20bc](https://github.com/costajohnt/oss-autopilot/commit/85a20bcfa115feae1834e15c058d5c358aa4c60e))
* **validation:** reject placeholder GitHub usernames at write side ([#1226](https://github.com/costajohnt/oss-autopilot/issues/1226)) ([24a85db](https://github.com/costajohnt/oss-autopilot/commit/24a85db20255939e44b80a82112cf652b01dd231))

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
