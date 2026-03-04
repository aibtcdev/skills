# Changelog

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
