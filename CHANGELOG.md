# Changelog

## [0.36.2](https://github.com/aibtcdev/skills/compare/skills-v0.36.1...skills-v0.36.2) (2026-04-03)


### Bug Fixes

* align relay payment polling contract with tx-schemas ([#290](https://github.com/aibtcdev/skills/issues/290)) ([8a0b532](https://github.com/aibtcdev/skills/commit/8a0b532b16684417c230150a1d3fef7d3f8a0d7a))

## [0.36.1](https://github.com/aibtcdev/skills/compare/skills-v0.36.0...skills-v0.36.1) (2026-03-31)


### Bug Fixes

* **x402-retry:** track pending payment ids ([#279](https://github.com/aibtcdev/skills/issues/279)) ([92ece39](https://github.com/aibtcdev/skills/commit/92ece391dd73fb28b8796a4141a44a4b23216b9c))

## [0.36.0](https://github.com/aibtcdev/skills/compare/skills-v0.35.0...skills-v0.36.0) (2026-03-28)


### Features

* **hodlmm-risk:** add HODLMM volatility risk monitoring skill ([#251](https://github.com/aibtcdev/skills/issues/251)) ([39bb078](https://github.com/aibtcdev/skills/commit/39bb07849cf9485eb34e349ca790f22921edbf6b))
* **nonce-manager:** add cross-process nonce oracle with acquire/release lifecycle ([#250](https://github.com/aibtcdev/skills/issues/250)) ([33f6e0b](https://github.com/aibtcdev/skills/commit/33f6e0bc497bc1a76cf42840520357d7838e61cb))
* **zest-yield-manager:** add Zest yield management skill ([#246](https://github.com/aibtcdev/skills/issues/246)) ([07f0df0](https://github.com/aibtcdev/skills/commit/07f0df0dceb76102ae7473335759a5c43e5a6568))


### Bug Fixes

* **runes:** add erc8004 AGENT.md and fix silent rune burn on partial transfers ([#244](https://github.com/aibtcdev/skills/issues/244)) ([e3b4fd3](https://github.com/aibtcdev/skills/commit/e3b4fd36d0e3f18682b3289c32d1a0b8f5a911ac))

## [0.35.0](https://github.com/aibtcdev/skills/compare/skills-v0.34.0...skills-v0.35.0) (2026-03-26)


### Features

* **x402:** add nonce tracking and retry logic for inbox messages ([#247](https://github.com/aibtcdev/skills/issues/247)) ([e2de2b1](https://github.com/aibtcdev/skills/commit/e2de2b1b0c55959afe04363394a0387f97579608)), closes [#240](https://github.com/aibtcdev/skills/issues/240)

## [0.34.0](https://github.com/aibtcdev/skills/compare/skills-v0.33.1...skills-v0.34.0) (2026-03-25)


### Features

* **paperboy:** add paid signal distribution skill (docs-only) ([530861a](https://github.com/aibtcdev/skills/commit/530861a4e611108d368a9d1b303f0ed7d46568d2)), closes [#221](https://github.com/aibtcdev/skills/issues/221)
* **paperboy:** add paid signal distribution skill (docs-only) ([#237](https://github.com/aibtcdev/skills/issues/237)) ([530861a](https://github.com/aibtcdev/skills/commit/530861a4e611108d368a9d1b303f0ed7d46568d2))

## [0.33.1](https://github.com/aibtcdev/skills/compare/skills-v0.33.0...skills-v0.33.1) (2026-03-25)


### Bug Fixes

* **rune-transfer-builder:** only set changeOutput pointer when change output is included ([0a0fd63](https://github.com/aibtcdev/skills/commit/0a0fd63077f887ec84f49bd91642c17fcc22292f)), closes [#229](https://github.com/aibtcdev/skills/issues/229)
* **rune-transfer-builder:** only set changeOutput pointer when change output is included ([#230](https://github.com/aibtcdev/skills/issues/230)) ([0a0fd63](https://github.com/aibtcdev/skills/commit/0a0fd63077f887ec84f49bd91642c17fcc22292f))
* update scaffold, docs, and bounty-scanner for nested metadata format ([1eb033d](https://github.com/aibtcdev/skills/commit/1eb033d477bf7fee87f915d0fd82f0b9559170c2))
* update scaffold, docs, and bounty-scanner for nested metadata format ([#232](https://github.com/aibtcdev/skills/issues/232)) ([1eb033d](https://github.com/aibtcdev/skills/commit/1eb033d477bf7fee87f915d0fd82f0b9559170c2))

## [0.33.0](https://github.com/aibtcdev/skills/compare/skills-v0.32.0...skills-v0.33.0) (2026-03-24)


### Features

* **clarity:** add Clarity development skills ([#222](https://github.com/aibtcdev/skills/issues/222)) ([55bbc20](https://github.com/aibtcdev/skills/commit/55bbc201c7fcd1de2b237990164ba01a2a8bad5d))

## [0.32.0](https://github.com/aibtcdev/skills/compare/skills-v0.31.1...skills-v0.32.0) (2026-03-24)


### Features

* **x402:** add --headers flag to execute-endpoint ([#211](https://github.com/aibtcdev/skills/issues/211)) ([6b8b93a](https://github.com/aibtcdev/skills/commit/6b8b93a2376fb272a00c5c06af6c0eb5aa067360))

## [0.31.1](https://github.com/aibtcdev/skills/compare/skills-v0.31.0...skills-v0.31.1) (2026-03-23)


### Bug Fixes

* **inscription-builder:** fix 3 bugs in buildRevealTransaction ([#216](https://github.com/aibtcdev/skills/issues/216)) ([d6648e9](https://github.com/aibtcdev/skills/commit/d6648e9fa7927c982763fdb01d108785872fa2d8))

## [0.31.0](https://github.com/aibtcdev/skills/compare/skills-v0.30.1...skills-v0.31.0) (2026-03-23)


### Features

* **aibtc-news:** add reset-leaderboard subcommand for publisher ([#212](https://github.com/aibtcdev/skills/issues/212)) ([0f09682](https://github.com/aibtcdev/skills/commit/0f09682a78f9b6b6f73db9a3fb8e7e91b8e8dc75))

## [0.30.1](https://github.com/aibtcdev/skills/compare/skills-v0.30.0...skills-v0.30.1) (2026-03-23)


### Bug Fixes

* **child-inscription:** add tapInternalKey to parent input in buildChildRevealTransaction ([#207](https://github.com/aibtcdev/skills/issues/207)) ([5bfc907](https://github.com/aibtcdev/skills/commit/5bfc907081f515f78fc4a895b7b88fecac1bfce2))

## [0.30.0](https://github.com/aibtcdev/skills/compare/skills-v0.29.0...skills-v0.30.0) (2026-03-23)


### Features

* add child-inscription-builder module ([#204](https://github.com/aibtcdev/skills/issues/204)) ([f892825](https://github.com/aibtcdev/skills/commit/f8928255294026042cfd3bbeb0f466393e1c97d5))


### Bug Fixes

* **aibtc-news-classifieds:** handle pending_review status from POST /api/classifieds ([#202](https://github.com/aibtcdev/skills/issues/202)) ([94d1977](https://github.com/aibtcdev/skills/commit/94d1977b0d41e52dae0648e1573a0d4a7becc167))
* **yield-dashboard:** read ALEX LP token balance for user positions ([#203](https://github.com/aibtcdev/skills/issues/203)) ([cb51ad3](https://github.com/aibtcdev/skills/commit/cb51ad362cabed164c6add10ca28d052a9f12184))

## [0.29.0](https://github.com/aibtcdev/skills/compare/skills-v0.28.0...skills-v0.29.0) (2026-03-20)


### Features

* **jingswap:** update contract names to sbtc-stx-jing / sbtc-usdcx-jing ([#199](https://github.com/aibtcdev/skills/issues/199)) ([1d640f7](https://github.com/aibtcdev/skills/commit/1d640f74e1733d3ca8826bb63d0f16d02955fbdc))
* **skills:** add nostr-wot, arxiv-research; update arc0btc config to v5 ([#188](https://github.com/aibtcdev/skills/issues/188)) ([fa784c7](https://github.com/aibtcdev/skills/commit/fa784c73fe790ffb812486aae18738208406c274))

## [0.28.0](https://github.com/aibtcdev/skills/compare/skills-v0.27.0...skills-v0.28.0) (2026-03-19)


### Features

* **aibtc-news:** add leaderboard, review-signal; add corrections to classifieds (closes [#171](https://github.com/aibtcdev/skills/issues/171)) ([#177](https://github.com/aibtcdev/skills/issues/177)) ([6488633](https://github.com/aibtcdev/skills/commit/6488633cd92846a033fbd27dabc8397d046085c5))
* **maximumsats-wot:** add WoT trust scoring skill ([#183](https://github.com/aibtcdev/skills/issues/183)) ([297f6c5](https://github.com/aibtcdev/skills/commit/297f6c566629330b95e2c75298ddaabb30ff57ee))
* **nostr:** NIP-06 derivation as default, add --key-source flag ([#187](https://github.com/aibtcdev/skills/issues/187)) ([6f796be](https://github.com/aibtcdev/skills/commit/6f796bedd6ab50d7f69bca54aecac7dd21782018)), closes [#86](https://github.com/aibtcdev/skills/issues/86)
* **stacking-lottery:** add stacking-lottery skill ([#185](https://github.com/aibtcdev/skills/issues/185)) ([dd0c912](https://github.com/aibtcdev/skills/commit/dd0c9127ef00dd90293ec0497f1e3e319b62c158)), closes [#184](https://github.com/aibtcdev/skills/issues/184)


### Bug Fixes

* **stacking-lottery:** use stacking_lottery mcp-tools instead of stackspot names ([#194](https://github.com/aibtcdev/skills/issues/194)) ([4e280b3](https://github.com/aibtcdev/skills/commit/4e280b33d00cb47b8c039f5f59803951f763b5a3)), closes [#190](https://github.com/aibtcdev/skills/issues/190)

## [0.27.0](https://github.com/aibtcdev/skills/compare/skills-v0.26.0...skills-v0.27.0) (2026-03-18)


### Features

* **aibtc-news:** add front-page, status filter, disclosure field (closes [#171](https://github.com/aibtcdev/skills/issues/171)) ([#172](https://github.com/aibtcdev/skills/issues/172)) ([5c73fcd](https://github.com/aibtcdev/skills/commit/5c73fcd4b1c6aec89b2590b5817d55b3a8e93d40))
* **bounty-scanner:** autonomous bounty hunting skill ([#91](https://github.com/aibtcdev/skills/issues/91)) ([e5d7b12](https://github.com/aibtcdev/skills/commit/e5d7b1249b7b4892239a6c0b6fb5d3710efb0856))
* **runes:** migrate to Unisat API, add Runes support and inscription/rune transfers ([#170](https://github.com/aibtcdev/skills/issues/170)) ([e77d006](https://github.com/aibtcdev/skills/commit/e77d006482d349e2734da0930360732b8c4007fe))


### Bug Fixes

* **bounty-scanner:** align with bounty.drx4.xyz API ([#178](https://github.com/aibtcdev/skills/issues/178)) ([8ad4248](https://github.com/aibtcdev/skills/commit/8ad424855eb497ab1265be00aa166a4b6ca936cf))

## [0.26.0](https://github.com/aibtcdev/skills/compare/skills-v0.25.0...skills-v0.26.0) (2026-03-17)


### Features

* **jingswap:** add multi-market support (sbtc-stx + sbtc-usdcx) ([#166](https://github.com/aibtcdev/skills/issues/166)) ([6a64491](https://github.com/aibtcdev/skills/commit/6a644918350fecc1a0a996797c0af2205ea94d33))
* **skills:** add jingswap to skills.json manifest ([#168](https://github.com/aibtcdev/skills/issues/168)) ([56144be](https://github.com/aibtcdev/skills/commit/56144beb14a36840064d66f49f2694007824b09a)), closes [#165](https://github.com/aibtcdev/skills/issues/165)

## [0.25.0](https://github.com/aibtcdev/skills/compare/skills-v0.24.0...skills-v0.25.0) (2026-03-16)


### Features

* **contract:** add contract deployment and interaction skill (closes [#138](https://github.com/aibtcdev/skills/issues/138)) ([#160](https://github.com/aibtcdev/skills/issues/160)) ([0b88f36](https://github.com/aibtcdev/skills/commit/0b88f36d63814bf7bdadafdc7e96bbc1575aabcb))
* **jingswap:** add blind batch auction skill for STX/sBTC ([#162](https://github.com/aibtcdev/skills/issues/162)) ([df91241](https://github.com/aibtcdev/skills/commit/df9124161a18741c2ef9ceb73f3bbe102c27a517))

## [0.24.0](https://github.com/aibtcdev/skills/compare/skills-v0.23.1...skills-v0.24.0) (2026-03-16)


### Features

* **child-inscription:** add parent-child Ordinals inscription skill (closes [#142](https://github.com/aibtcdev/skills/issues/142)) ([#152](https://github.com/aibtcdev/skills/issues/152)) ([72e8ad6](https://github.com/aibtcdev/skills/commit/72e8ad657444f199c593ad02897dd5c3753acfd4))
* **erc8004:** add ERC-8004 on-chain agent identity skill (closes [#141](https://github.com/aibtcdev/skills/issues/141)) ([#156](https://github.com/aibtcdev/skills/issues/156)) ([322271e](https://github.com/aibtcdev/skills/commit/322271e0f2e3c1306f63750ec5ac5f5b8e798801))
* **inbox:** add x402-gated inbox skill (closes [#146](https://github.com/aibtcdev/skills/issues/146)) ([#149](https://github.com/aibtcdev/skills/issues/149)) ([387b221](https://github.com/aibtcdev/skills/commit/387b2214dd2dc12e8235def935b9f3095548b5fe))
* **openrouter:** add OpenRouter AI integration skill ([#148](https://github.com/aibtcdev/skills/issues/148)) ([bc644b0](https://github.com/aibtcdev/skills/commit/bc644b0d2088025510e8d657588af8565087fc79))
* **psbt:** add PSBT construction and signing skill (closes [#144](https://github.com/aibtcdev/skills/issues/144)) ([#153](https://github.com/aibtcdev/skills/issues/153)) ([8010455](https://github.com/aibtcdev/skills/commit/8010455f2874c1ca2cb7af174be3a939142fadc1))
* **relay-diagnostic:** add sponsor relay health and nonce recovery skill (closes [#140](https://github.com/aibtcdev/skills/issues/140)) ([#150](https://github.com/aibtcdev/skills/issues/150)) ([6903de2](https://github.com/aibtcdev/skills/commit/6903de2444ce7fdf8c5f795850db6cc05ffa38e1))
* **souldinals:** add soul.md inscription and collection management skill ([#159](https://github.com/aibtcdev/skills/issues/159)) ([8d5f0c2](https://github.com/aibtcdev/skills/commit/8d5f0c2cb72509e4904aeea203b2a9152643e891))
* **transfer:** add STX, token, and NFT transfer skill (closes [#139](https://github.com/aibtcdev/skills/issues/139)) ([#151](https://github.com/aibtcdev/skills/issues/151)) ([530dc8c](https://github.com/aibtcdev/skills/commit/530dc8cc65cb3ac41bb4d2c2029807d7c07f6220))


### Bug Fixes

* **mempool-watch:** update mcp-tools refs for renamed btc tools ([#161](https://github.com/aibtcdev/skills/issues/161)) ([879e668](https://github.com/aibtcdev/skills/commit/879e668cc293495bfd9ecf9cc2f701e49f04570f))
* replace bare catch-return-null with selective 404 guards ([#155](https://github.com/aibtcdev/skills/issues/155)) ([b7d1313](https://github.com/aibtcdev/skills/commit/b7d1313d570896c3397ef7b8bfd4851cc253d9db)), closes [#154](https://github.com/aibtcdev/skills/issues/154)
* **skills:** correct validation failures in openrouter and relay-diagnostic SKILL.md ([#158](https://github.com/aibtcdev/skills/issues/158)) ([3247563](https://github.com/aibtcdev/skills/commit/3247563d6ce7d2c77ec75764925afc74ac3e1e78))
* **stackspot:** add mcp-tools metadata field (closes [#145](https://github.com/aibtcdev/skills/issues/145)) ([#147](https://github.com/aibtcdev/skills/issues/147)) ([3790d66](https://github.com/aibtcdev/skills/commit/3790d6660dcbade354283255cf471c02bd6df867))

## [0.23.1](https://github.com/aibtcdev/skills/compare/skills-v0.23.0...skills-v0.23.1) (2026-03-15)


### Bug Fixes

* **bitflow:** default USDC references to USDCx ([#134](https://github.com/aibtcdev/skills/issues/134)) ([852a8a9](https://github.com/aibtcdev/skills/commit/852a8a9be256c87bad511322651b8554bb1bb79f))

## [0.23.0](https://github.com/aibtcdev/skills/compare/skills-v0.22.0...skills-v0.23.0) (2026-03-13)


### Features

* **skills:** migrate to agentskills.io spec compliance ([#135](https://github.com/aibtcdev/skills/issues/135)) ([03adaab](https://github.com/aibtcdev/skills/commit/03adaab6a0795727fd668a9aa895998387889365))

## [0.22.0](https://github.com/aibtcdev/skills/compare/skills-v0.21.0...skills-v0.22.0) (2026-03-13)


### Features

* **src:** add normalized state file envelope ([#132](https://github.com/aibtcdev/skills/issues/132)) ([56c1346](https://github.com/aibtcdev/skills/commit/56c1346a1be4271c5a6ac8eed4edc0ef065e2c26))

## [0.21.0](https://github.com/aibtcdev/skills/compare/skills-v0.20.1...skills-v0.21.0) (2026-03-13)


### Features

* **skills:** add mcp-tools field to SKILL.md frontmatter ([#128](https://github.com/aibtcdev/skills/issues/128)) ([#129](https://github.com/aibtcdev/skills/issues/129)) ([28d8d83](https://github.com/aibtcdev/skills/commit/28d8d835ca62b549361cbea596b29760519b213e))
* **tenero:** add tenero market analytics skill ([#125](https://github.com/aibtcdev/skills/issues/125)) ([#130](https://github.com/aibtcdev/skills/issues/130)) ([93cc20d](https://github.com/aibtcdev/skills/commit/93cc20d8e5ff9a925370906cb1bdc81b1fc063da))

## [0.20.1](https://github.com/aibtcdev/skills/compare/skills-v0.20.0...skills-v0.20.1) (2026-03-13)


### Bug Fixes

* **aibtc-news:** migrate to v2 API auth headers and snake_case bodies ([#127](https://github.com/aibtcdev/skills/issues/127)) ([acb4c75](https://github.com/aibtcdev/skills/commit/acb4c7555d8de2972b54d7e2919e65049a5e4858))
* **x402:** migrate wrangler.jsonc template to use JSONC comments ([#124](https://github.com/aibtcdev/skills/issues/124)) ([431e727](https://github.com/aibtcdev/skills/commit/431e727a591837f888a2706c18c73332fdba7270)), closes [#115](https://github.com/aibtcdev/skills/issues/115)

## [0.20.0](https://github.com/aibtcdev/skills/compare/skills-v0.19.1...skills-v0.20.0) (2026-03-12)


### Features

* **agent-lookup:** add agent-lookup skill ([#123](https://github.com/aibtcdev/skills/issues/123)) ([12af974](https://github.com/aibtcdev/skills/commit/12af9742d15bc5e5f77fb55b6b74c28710d0cb5a))
* **aibtc-agents:** add SKILL.md and update manifest ([#120](https://github.com/aibtcdev/skills/issues/120)) ([221e4b5](https://github.com/aibtcdev/skills/commit/221e4b5a79cd58ad499aa0b04cb0596739a09b21))
* **bitflow:** unify SDK and HODLMM routing and ranking ([#111](https://github.com/aibtcdev/skills/issues/111)) ([fea9df6](https://github.com/aibtcdev/skills/commit/fea9df6940e751a2c2d825e924a7edb6120c5156))
* **mempool-watch:** add mempool-watch skill ([#105](https://github.com/aibtcdev/skills/issues/105)) ([a803503](https://github.com/aibtcdev/skills/commit/a803503f78cb42230818b7ae9ffe0fa74557aee7))

## [0.19.1](https://github.com/aibtcdev/skills/compare/skills-v0.19.0...skills-v0.19.1) (2026-03-12)


### Bug Fixes

* **defi:** read Zest supply from LP token balance, not reserve data ([#117](https://github.com/aibtcdev/skills/issues/117)) ([6b2c2a6](https://github.com/aibtcdev/skills/commit/6b2c2a6133cde485e9b05c2897cc9b45bf34e47b))

## [0.19.0](https://github.com/aibtcdev/skills/compare/skills-v0.18.1...skills-v0.19.0) (2026-03-12)


### Features

* **aibtc-agents:** add iris0btc, loom0btc, and forge0btc agent configs ([#106](https://github.com/aibtcdev/skills/issues/106)) ([e0eb01e](https://github.com/aibtcdev/skills/commit/e0eb01e5133d3d9c1ad149397217423fd48e6a04))


### Bug Fixes

* **erc8004:** add NFT post-condition to transferIdentity ([#109](https://github.com/aibtcdev/skills/issues/109)) ([11d662d](https://github.com/aibtcdev/skills/commit/11d662d221aeb7ace11a56e83653b7685e9ce1f3))
* persist wallet session across process boundaries (closes [#87](https://github.com/aibtcdev/skills/issues/87)) ([#107](https://github.com/aibtcdev/skills/issues/107)) ([992e0c1](https://github.com/aibtcdev/skills/commit/992e0c1f993eaa4f630d7c29b1106c50930fb6dd))
* **x402:** detect sbtc-token contract identifier in detectTokenType ([#101](https://github.com/aibtcdev/skills/issues/101)) ([f6b383e](https://github.com/aibtcdev/skills/commit/f6b383e59476f40221988012befc779d9a6d46ea))

## [0.18.1](https://github.com/aibtcdev/skills/compare/skills-v0.18.0...skills-v0.18.1) (2026-03-09)


### Bug Fixes

* **lib:** add node: prefix to bare stdlib imports in src/lib ([#103](https://github.com/aibtcdev/skills/issues/103)) ([615f3bf](https://github.com/aibtcdev/skills/commit/615f3bf2350cc0c4eba838eea46b7aacafd4e95c)), closes [#94](https://github.com/aibtcdev/skills/issues/94)

## [0.18.0](https://github.com/aibtcdev/skills/compare/skills-v0.17.0...skills-v0.18.0) (2026-03-06)


### Features

* multi-author support and full author attribution ([#97](https://github.com/aibtcdev/skills/issues/97)) ([fc82ef7](https://github.com/aibtcdev/skills/commit/fc82ef70bd8c9a31fcf27f091636304f33e94ecf))

## [0.17.0](https://github.com/aibtcdev/skills/compare/skills-v0.16.0...skills-v0.17.0) (2026-03-06)


### Features

* **ordinals-p2p:** P2P ordinals trading skill ([#79](https://github.com/aibtcdev/skills/issues/79)) ([a138596](https://github.com/aibtcdev/skills/commit/a138596b7867949dee77e93beff206ecc1ab1865))

## [0.16.0](https://github.com/aibtcdev/skills/compare/skills-v0.15.0...skills-v0.16.0) (2026-03-06)


### Features

* add author attribution to skill frontmatter ([#90](https://github.com/aibtcdev/skills/issues/90)) ([f90b996](https://github.com/aibtcdev/skills/commit/f90b9966a63265fffef583d3a487311d8ce83797))
* add skill scaffolding script for new contributors ([#89](https://github.com/aibtcdev/skills/issues/89)) ([a0def2c](https://github.com/aibtcdev/skills/commit/a0def2cee5dbb2853d6b49514b605f40254a5e20))
* add yield-dashboard skill — cross-protocol DeFi yield aggregator ([#82](https://github.com/aibtcdev/skills/issues/82)) ([979bd69](https://github.com/aibtcdev/skills/commit/979bd69eddb755d903e27a8d07586d58f7d3726e))
* **nostr:** add amplify-signal and amplify-text subcommands ([#92](https://github.com/aibtcdev/skills/issues/92)) ([7100cd6](https://github.com/aibtcdev/skills/commit/7100cd6e66d435586baf1ff9e438e03ee43d2ec0))
* **onboarding:** add agent onboarding automation skill ([#81](https://github.com/aibtcdev/skills/issues/81)) ([867f8f8](https://github.com/aibtcdev/skills/commit/867f8f877f209033d04086c7a484389ef09a2f23))


### Bug Fixes

* **styx:** move OP_RETURN to output index 0 for Styx protocol compliance ([#85](https://github.com/aibtcdev/skills/issues/85)) ([9f7c6a6](https://github.com/aibtcdev/skills/commit/9f7c6a634bdde0adc9b4fa80fea68b31d152745a))

## [0.15.0](https://github.com/aibtcdev/skills/compare/skills-v0.14.0...skills-v0.15.0) (2026-03-05)


### Features

* **styx:** add BTC→sBTC conversion skill via Styx protocol ([#78](https://github.com/aibtcdev/skills/issues/78)) ([db36f98](https://github.com/aibtcdev/skills/commit/db36f980cfc82cb57fbb57ef7c4684fc11347a8f))

## [0.14.0](https://github.com/aibtcdev/skills/compare/skills-v0.13.0...skills-v0.14.0) (2026-03-04)


### Features

* **dual-stacking:** add dual stacking enrollment skill ([#76](https://github.com/aibtcdev/skills/issues/76)) ([07ca9fb](https://github.com/aibtcdev/skills/commit/07ca9fb7136be0c790d8878a15e4b9f9943c84d0))
* **nostr:** add nostr skill ([#73](https://github.com/aibtcdev/skills/issues/73)) ([2a03684](https://github.com/aibtcdev/skills/commit/2a03684d44f80ce8752251b6eff04f3099e4a5ba))
* **what-to-do:** add project board scanning workflow ([#74](https://github.com/aibtcdev/skills/issues/74)) ([6bb4904](https://github.com/aibtcdev/skills/commit/6bb490491584b508b98962dbbf612f74333bd2b5)), closes [#28](https://github.com/aibtcdev/skills/issues/28)


### Bug Fixes

* **signing:** align SIP-018 domain parsing with MCP shape ([#75](https://github.com/aibtcdev/skills/issues/75)) ([e91309f](https://github.com/aibtcdev/skills/commit/e91309fcf5ee3051aaeb38c9660807ca0c77abb1))

## [0.13.0](https://github.com/aibtcdev/skills/compare/skills-v0.12.1...skills-v0.13.0) (2026-03-03)


### Features

* **taproot-multisig:** add Taproot M-of-N multisig coordination skill ([#71](https://github.com/aibtcdev/skills/issues/71)) ([60a0ccc](https://github.com/aibtcdev/skills/commit/60a0ccc94bc82d8aeb84441cdbed2ef79469d52b))

## [0.12.1](https://github.com/aibtcdev/skills/compare/skills-v0.12.0...skills-v0.12.1) (2026-03-02)


### Bug Fixes

* pass msgBytes directly to taggedHash, removing the encodeVarInt call. ([720c90c](https://github.com/aibtcdev/skills/commit/720c90cf7cdddc8c9e8ee6f713e6d0db663bc520))
* **signing:** remove varint prepend from bip322TaggedHash ([#69](https://github.com/aibtcdev/skills/issues/69)) ([720c90c](https://github.com/aibtcdev/skills/commit/720c90cf7cdddc8c9e8ee6f713e6d0db663bc520))

## [0.12.0](https://github.com/aibtcdev/skills/compare/skills-v0.11.0...skills-v0.12.0) (2026-03-02)


### Features

* **business-dev:** add business development skill ([#65](https://github.com/aibtcdev/skills/issues/65)) ([eaf8e3f](https://github.com/aibtcdev/skills/commit/eaf8e3f46c3bb54052c1bdc1c237b6d92d89cc49))
* **ceo:** add CEO operating manual skill for agent guidance ([#67](https://github.com/aibtcdev/skills/issues/67)) ([9cf5d1f](https://github.com/aibtcdev/skills/commit/9cf5d1fc397658e6c0f7a6bed7ed5260c819843d))

## [0.11.0](https://github.com/aibtcdev/skills/compare/skills-v0.10.1...skills-v0.11.0) (2026-02-28)


### Features

* add aibtc-news and aibtc-news-protocol skills ([#46](https://github.com/aibtcdev/skills/issues/46)) ([9a361b7](https://github.com/aibtcdev/skills/commit/9a361b7fb77509a540c5a7182385841f7ca255cf))
* **aibtc-agents:** add spark0btc agent config ([#61](https://github.com/aibtcdev/skills/issues/61)) ([5e83bf4](https://github.com/aibtcdev/skills/commit/5e83bf4d532da95eab687b815db7019a504d20cd))
* full ERC-8004 support — split identity into identity, reputation, validation skills ([#45](https://github.com/aibtcdev/skills/issues/45)) ([d68329d](https://github.com/aibtcdev/skills/commit/d68329d71fec0ef5f456639708990f29ac575f22))
* **settings:** add check-relay-health subcommand (closes [#51](https://github.com/aibtcdev/skills/issues/51)) ([#56](https://github.com/aibtcdev/skills/issues/56)) ([6ef5b34](https://github.com/aibtcdev/skills/commit/6ef5b34b6f2055e02b9403ff6f6095e005f4b95e))


### Bug Fixes

* align sip018-sign/hash domain params with MCP ([#50](https://github.com/aibtcdev/skills/issues/50)) ([#58](https://github.com/aibtcdev/skills/issues/58)) ([60ca60c](https://github.com/aibtcdev/skills/commit/60ca60cf7cd6e11a41b4e481990fe0af76bf21a5))
* use v2 header name payment-required instead of x-payment-required in send-inbox-message ([9a2f3f8](https://github.com/aibtcdev/skills/commit/9a2f3f8010a0575910119605ba683bffd2a5b9dd))
* **x402:** use v2 header name for payment-required in send-inbox-message ([#59](https://github.com/aibtcdev/skills/issues/59)) ([9a2f3f8](https://github.com/aibtcdev/skills/commit/9a2f3f8010a0575910119605ba683bffd2a5b9dd))

## [0.10.1](https://github.com/aibtcdev/skills/compare/skills-v0.10.0...skills-v0.10.1) (2026-02-27)


### Bug Fixes

* **what-to-do:** correct aibtc.com API alignment in workflow guides ([#52](https://github.com/aibtcdev/skills/issues/52)) ([884ce0b](https://github.com/aibtcdev/skills/commit/884ce0b9729d7394c55a042a4e5c01ab4fbeffe5))

## [0.10.0](https://github.com/aibtcdev/skills/compare/skills-v0.9.0...skills-v0.10.0) (2026-02-26)


### Features

* **aibtc-agents:** add tiny-marten config and two workflow guides ([#42](https://github.com/aibtcdev/skills/issues/42)) ([e028c02](https://github.com/aibtcdev/skills/commit/e028c02430adbc51b9be00a70cf51a252f8b6936))
* **stacks-market:** add prediction market skill ([#30](https://github.com/aibtcdev/skills/issues/30)) ([45067ea](https://github.com/aibtcdev/skills/commit/45067ea946cc291e14142403551441f9d2889048))
* **stackspot:** add stacking lottery skill ([#31](https://github.com/aibtcdev/skills/issues/31)) ([569fb3c](https://github.com/aibtcdev/skills/commit/569fb3cc6c51037f8f3cdff1e859e638122f0416))
* **test:** add unit tests for config, transactions, and services (77 tests) ([d17dda5](https://github.com/aibtcdev/skills/commit/d17dda5f95900b8edeaef3fd8af49c588a13a887))


### Bug Fixes

* **stackspot:** accept fully qualified contract identifiers ([#44](https://github.com/aibtcdev/skills/issues/44)) ([4b56455](https://github.com/aibtcdev/skills/commit/4b564552e0a56dec30b9a3f34878d83a07f33187))

## [0.9.0](https://github.com/aibtcdev/skills/compare/skills-v0.8.0...skills-v0.9.0) (2026-02-24)


### Features

* **what-to-do:** add autonomy workflows and update registration flow ([#37](https://github.com/aibtcdev/skills/issues/37)) ([a7a0bd6](https://github.com/aibtcdev/skills/commit/a7a0bd6ac3cb6a880ff9ecd08fc74e1335661d70))

## [0.8.0](https://github.com/aibtcdev/skills/compare/skills-v0.7.0...skills-v0.8.0) (2026-02-24)


### Features

* **signing:** add BIP-322 support for bc1q and bc1p addresses ([#32](https://github.com/aibtcdev/skills/issues/32)) ([d70d07c](https://github.com/aibtcdev/skills/commit/d70d07c6f312dc6bca336c91515f723853b9878b))

## [0.7.0](https://github.com/aibtcdev/skills/compare/skills-v0.6.0...skills-v0.7.0) (2026-02-24)


### Features

* **what-to-do:** add setup-autonomous-loop workflow + update secret-mars config ([#22](https://github.com/aibtcdev/skills/issues/22)) ([c9565f7](https://github.com/aibtcdev/skills/commit/c9565f75f9a3e68e9718c2fcb0a50509b290a772))


### Bug Fixes

* **bitflow:** correct amount-in docs — human-readable decimal, not smallest units ([#26](https://github.com/aibtcdev/skills/issues/26)) ([2236cc4](https://github.com/aibtcdev/skills/commit/2236cc46b09f5ea2290958fc7946719c0a3c583a))

## [0.6.0](https://github.com/aibtcdev/skills/compare/skills-v0.5.0...skills-v0.6.0) (2026-02-21)


### Features

* **aibtc-agents:** add secret-mars agent config ([#18](https://github.com/aibtcdev/skills/issues/18)) ([f80ddd7](https://github.com/aibtcdev/skills/commit/f80ddd7f0524c26d9592c446d5aeb6a2f3923408))

## [0.5.0](https://github.com/aibtcdev/skills/compare/skills-v0.4.0...skills-v0.5.0) (2026-02-20)


### Features

* AX/UX audit phases 1-5 (skills repo) ([#12](https://github.com/aibtcdev/skills/issues/12)) ([680dcf5](https://github.com/aibtcdev/skills/commit/680dcf593c57aa55cd6140e4590434e5e8de38a3))

## [0.4.0](https://github.com/aibtcdev/skills/compare/skills-v0.3.0...skills-v0.4.0) (2026-02-20)


### Features

* skill metadata manifest and agent experience improvements ([#10](https://github.com/aibtcdev/skills/issues/10)) ([235c7cf](https://github.com/aibtcdev/skills/commit/235c7cfe7939711f3fbd832457baf2bb802a23b9))

## [0.3.0](https://github.com/aibtcdev/skills/compare/skills-v0.2.0...skills-v0.3.0) (2026-02-20)


### Features

* add CONTRIBUTING.md, wallet import docs, and Result type ([#6](https://github.com/aibtcdev/skills/issues/6)) ([831c810](https://github.com/aibtcdev/skills/commit/831c81070e70f877129c8b5725e2b0e6f915c149))

## [0.2.0](https://github.com/aibtcdev/skills/compare/skills-v0.1.0...skills-v0.2.0) (2026-02-20)


### Features

* convert MCP server to Claude Code skills ([fae4417](https://github.com/aibtcdev/skills/commit/fae4417e81aa88d7e600b590a2cce5567d0926b3))
* initial project scaffold ([d3c2928](https://github.com/aibtcdev/skills/commit/d3c2928cf05a942d044fa59a7329538d3902c6bd))
* skill-discovery-layer — workflow guides, agent configs, AGENT.md convention, credential store ([#4](https://github.com/aibtcdev/skills/issues/4)) ([7f62fe5](https://github.com/aibtcdev/skills/commit/7f62fe57aa156081dd464127ec4645b028a5acbb))
* sync with mcp-server v1.25.0 — Schnorr signing, Bitflow DEX, public API ([cf2ab75](https://github.com/aibtcdev/skills/commit/cf2ab75723f1ed51909205ba241a9732dc65160d))
