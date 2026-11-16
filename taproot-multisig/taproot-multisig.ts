#!/usr/bin/env bun
/**
 * Taproot Multisig skill CLI
 * Agent-to-agent Bitcoin Taproot M-of-N multisig coordination.
 *
 * Proven on mainnet:
 *   2-of-2: block 937,849 (Arc + Aetos)
 *   3-of-3: block 938,206 (Arc + Aetos + Bitclaw)
 *
 * Usage: bun run taproot-multisig/taproot-multisig.ts <subcommand> [options]
 */

import { Command } from "commander";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { NETWORK } from "@aibtc/skills/src/lib/config/networks.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";

function requireUnlockedWallet() {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Run: bun run wallet/wallet.ts unlock --password <password>"
    );
  }
  return account;
}

const program = new Command();

program
  .name("taproot-multisig")
  .description(
    "Bitcoin Taproot M-of-N multisig coordination — share pubkeys, verify co-signer signatures, " +
      "and navigate the OP_CHECKSIGADD signing workflow. " +
      "Proven on mainnet: 2-of-2 (block 937,849) and 3-of-3 (block 938,206)."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-pubkey
// ---------------------------------------------------------------------------

program
  .command("get-pubkey")
  .description(
    "Get your x-only Taproot internal public key for registering with a multisig coordinator. " +
      "Share this key — not your address, not the tweaked key — when joining a QuorumClaw or similar multisig wallet. " +
      "Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const account = requireUnlockedWallet();

      if (!account.taprootPublicKey || !account.taprootAddress) {
        throw new Error(
          "Taproot keys not available. Ensure the wallet has Taproot key derivation."
        );
      }

      const internalPubKey = hex.encode(account.taprootPublicKey);
      const derivationPath =
        NETWORK === "mainnet" ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0";

      printJson({
        success: true,
        internalPubKey,
        taprootAddress: account.taprootAddress,
        network: NETWORK,
        keyFormat: "x-only (32 bytes)",
        derivationPath,
        usage:
          "Register 'internalPubKey' when joining a multisig. " +
          "Sign proposals with: bun run signing/signing.ts schnorr-sign-digest --digest <sighash> --confirm-blind-sign",
        warning:
          "Always register internalPubKey, NOT the tweaked key. " +
          "The tweaked key is embedded in the bc1p address and requires different signing logic. " +
          "Mixing internal and tweaked keys causes signature verification failures.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// verify-cosig
// ---------------------------------------------------------------------------

program
  .command("verify-cosig")
  .description(
    "Verify a BIP-340 Schnorr signature from a co-signer. " +
      "Use after receiving signatures from the coordination API to confirm each co-signer's key " +
      "actually signed the sighash. Does not require an unlocked wallet."
  )
  .requiredOption(
    "--digest <hex>",
    "32-byte hex-encoded sighash digest (received from coordination API)"
  )
  .requiredOption(
    "--signature <hex>",
    "64-byte hex-encoded BIP-340 Schnorr signature from co-signer"
  )
  .requiredOption(
    "--public-key <hex>",
    "32-byte hex-encoded x-only public key of the co-signer"
  )
  .action(
    async (opts: { digest: string; signature: string; publicKey: string }) => {
      try {
        const digestBytes = hex.decode(opts.digest);
        const sigBytes = hex.decode(opts.signature);
        const pubKeyBytes = hex.decode(opts.publicKey);

        if (digestBytes.length !== 32) {
          throw new Error("--digest must be exactly 32 bytes (64 hex chars)");
        }
        if (sigBytes.length !== 64) {
          throw new Error(
            "--signature must be exactly 64 bytes (128 hex chars)"
          );
        }
        if (pubKeyBytes.length !== 32) {
          throw new Error(
            "--public-key must be exactly 32 bytes (64 hex chars)"
          );
        }

        const isValid = schnorr.verify(sigBytes, digestBytes, pubKeyBytes);

        printJson({
          success: true,
          isValid,
          digest: opts.digest,
          signature: opts.signature,
          publicKey: opts.publicKey,
          message: isValid
            ? "Signature is valid — this co-signer's key signed this digest."
            : "Signature is INVALID — do not proceed. Key mismatch or digest was tampered.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// guide
// ---------------------------------------------------------------------------

program
  .command("guide")
  .description(
    "Print the complete step-by-step Taproot multisig workflow as JSON. " +
      "Covers key registration, sighash signing, witness assembly, and the BIP-86 internal-vs-tweaked key gotcha."
  )
  .action(async () => {
    try {
      printJson({
        title: "Bitcoin Taproot Multisig: Agent-to-Agent Coordination Guide",
        description:
          "How to execute M-of-N Taproot multisig transactions between autonomous agents " +
          "using BIP-340 Schnorr signatures and OP_CHECKSIGADD.",
        provenOnMainnet: [
          {
            type: "2-of-2",
            txid: "d05806c87ceae62e8f47daafb9fe4842c837fa3f333864cd5a5ec9d2a38cf96b",
            block: 937849,
            signers: ["Arc (arc0btc)", "Aetos (SetZeus)"],
            coordination: "SetZeus multisig API",
            date: "2026-02-22",
            verifyUrl:
              "https://mempool.space/tx/d05806c87ceae62e8f47daafb9fe4842c837fa3f333864cd5a5ec9d2a38cf96b",
          },
          {
            type: "3-of-3",
            txid: "47dbaf5185b582902b43241e757c6bc6a1c60b4418453d93b2ffbb0315f87e92",
            block: 938206,
            multisigAddress:
              "bc1pysmgn5dnmht8rzp542kcf7gyftkuczwwwfvld4lfr64udxfe4yssktp35t",
            signers: ["Arc (arc0btc)", "Aetos (SetZeus)", "Bitclaw"],
            coordination: "QuorumClaw API",
            date: "2026-02-25",
            verifyUrl:
              "https://mempool.space/tx/47dbaf5185b582902b43241e757c6bc6a1c60b4418453d93b2ffbb0315f87e92",
          },
        ],
        bipsUsed: {
          "BIP-340":
            "Schnorr signatures — 64-byte, x-only pubkeys, deterministic + side-channel resistant",
          "BIP-341":
            "Taproot output structure — key-path and script-path spending",
          "BIP-342":
            "Tapscript — OP_CHECKSIGADD for M-of-N threshold multisig",
          "BIP-86":
            "HD key derivation for Taproot — m/86'/[coinType]'/0'/0/0",
        },
        workflow: [
          {
            step: 1,
            title: "Get Your Public Key",
            description:
              "Derive your x-only Taproot internal public key and share it with the coordinator.",
            command:
              "bun run taproot-multisig/taproot-multisig.ts get-pubkey",
            shareField: "internalPubKey",
            note: "Share the 'internalPubKey' (32 bytes hex), NOT the tweaked key or the address.",
          },
          {
            step: 2,
            title: "Join the Multisig Wallet",
            description:
              "All N signers register their x-only public keys with the coordinator (e.g., QuorumClaw). " +
              "The coordinator derives the multisig address from the combined pubkeys and threshold M.",
            tapscriptPattern:
              "<pubkey1> OP_CHECKSIG <pubkey2> OP_CHECKSIGADD ... <M> OP_NUMEQUAL",
            note: "The multisig address is a P2TR output. Wait for all N signers to join before creating proposals.",
          },
          {
            step: 3,
            title: "Create a Spending Proposal",
            description:
              "One signer (or the coordinator) creates a proposal: recipient, amount, fee. " +
              "The coordinator computes the BIP-341 sighash and distributes it to all signers.",
            note: "The sighash is a 32-byte digest. It is the only data you sign.",
          },
          {
            step: 4,
            title: "Sign the Sighash",
            description:
              "Each signer independently signs the 32-byte sighash using BIP-340 Schnorr. " +
              "First call without --confirm-blind-sign shows the digest for review; add the flag to sign.",
            command:
              "bun run signing/signing.ts schnorr-sign-digest --digest <sighash_hex> --confirm-blind-sign",
            submitToApi: "signature (128 hex chars) + publicKey (64 hex chars)",
            warning:
              "Verify the sighash source before signing. Once the threshold is met, the coordinator may broadcast.",
            note: "Uses your internal BIP-86 key. This matches the internalPubKey you registered in step 1.",
          },
          {
            step: 5,
            title: "Verify Co-Signers (Recommended)",
            description:
              "After all signatures are collected, verify each co-signer's signature before broadcast.",
            command:
              "bun run taproot-multisig/taproot-multisig.ts verify-cosig --digest <sighash_hex> --signature <cosig_hex> --public-key <pubkey_hex>",
            note: "Repeat for each co-signer. isValid:true confirms the key signed this exact sighash.",
          },
          {
            step: 6,
            title: "Broadcast",
            description:
              "Once M signatures are collected and valid, the coordinator assembles the witness stack and broadcasts.",
            witnessStackFormat:
              "<sig_1> <sig_2> ... <sig_M> <tapscript> <control_block>",
            note: "The coordinator handles assembly. Your role ends at step 4.",
          },
        ],
        criticalGotcha: {
          title: "BIP-86 Internal Key vs Tweaked Key",
          summary:
            "The key you register must match the key you sign with. " +
            "The signing skill (schnorr-sign-digest) uses the internal key. " +
            "Always register internalPubKey.",
          internalKey: {
            description:
              "Raw x-only public key at m/86'/[coinType]'/0'/0/0. " +
              "What get-pubkey returns as 'internalPubKey'.",
            signWith:
              "signing/signing.ts schnorr-sign-digest — uses internal key by default",
          },
          tweakedKey: {
            description:
              "Internal key tweaked by H_TapTweak(P). Embedded in the bc1p... address.",
            formula: "tweakedPubKey = internalKey + H_TapTweak(internalKey) * G",
            privateKeyFormula:
              "d' = d + H_TapTweak(P) mod n (with Y-parity negation when needed)",
            warning:
              "Requires custom derivation not exposed in the signing skill. Avoid unless coordinator requires it.",
          },
          recommendation:
            "Register internalPubKey. Sign with schnorr-sign-digest. They match. Done.",
          whatHappensIfMixed:
            "Your signature is cryptographically valid but verifies against the wrong key. " +
            "The coordination API will reject it. You'll need to re-derive the tweaked private key and re-sign.",
          realWorldExample:
            "Arc's 3-of-3 first attempt failed because the previous session registered the tweaked pubkey. " +
            "Fix: re-sign using tweaked private key formula. Lesson: always use internalPubKey.",
        },
        mOfNThresholds: {
          description:
            "OP_CHECKSIGADD supports any M-of-N, not just N-of-N. " +
            "Going from 3-of-3 to 2-of-3 is a one-line Tapscript change. " +
            "The key exchange and signing flow are identical.",
          examples: {
            "2-of-2": "Bilateral custody — both must agree, funds frozen if one offline",
            "2-of-3":
              "Resilient — one signer can be offline or compromised, operation continues",
            "3-of-5":
              "DAO governance — majority coalition can act without unanimity",
            "N-of-N":
              "Maximum security — all signers required (what Arc proved on mainnet)",
          },
        },
        libraries: {
          "@scure/btc-signer": "BIP-86 Taproot key derivation, p2tr address generation",
          "@noble/curves/secp256k1":
            "BIP-340 Schnorr sign/verify (schnorr.sign, schnorr.verify)",
          "@scure/bip32": "HD key derivation (BIP-32 HDKey)",
          "@scure/bip39": "BIP-39 mnemonic to seed",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

program.parse(process.argv);
