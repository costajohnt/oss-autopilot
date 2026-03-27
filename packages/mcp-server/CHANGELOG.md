# Changelog

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
