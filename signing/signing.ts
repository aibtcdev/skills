#!/usr/bin/env bun
/**
 * Signing skill CLI
 * Message signing capabilities: SIP-018 structured data, Stacks messages (SIWS), Bitcoin messages (BIP-137)
 *
 * Usage: bun run signing/signing.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  signStructuredData,
  hashStructuredData,
  encodeStructuredDataBytes,
  publicKeyFromSignatureRsv,
  getAddressFromPublicKey,
  signMessageHashRsv,
  tupleCV,
  stringAsciiCV,
  stringUtf8CV,
  uintCV,
  intCV,
  principalCV,
  bufferCV,
  listCV,
  noneCV,
  someCV,
  trueCV,
  falseCV,
  type ClarityValue,
} from "@stacks/transactions";
import {
  hashMessage,
  verifyMessageSignatureRsv,
  hashSha256Sync,
} from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { NETWORK } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Chain IDs for SIP-018 domain (from SIP-005)
 */
const CHAIN_IDS = {
  mainnet: 1,
  testnet: 2147483648, // 0x80000000
} as const;

/**
 * SIP-018 structured data prefix as hex.
 * ASCII "SIP018" = 0x534950303138
 */
const SIP018_MSG_PREFIX = "0x534950303138";

/**
 * Stacks message signing prefix (SIWS-compatible)
 */
const STACKS_MSG_PREFIX = "\x17Stacks Signed Message:\n";

/**
 * Bitcoin message signing prefix (BIP-137)
 */
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

/**
 * BIP-137 header byte base values for different address types.
 */
const BIP137_HEADER_BASE = {
  P2PKH_UNCOMPRESSED: 27,
  P2PKH_COMPRESSED: 31,
  P2SH_P2WPKH: 35,
  P2WPKH: 39,
} as const;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Encode a variable-length integer (Bitcoin varint format).
 */
function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  } else if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  } else {
    throw new Error("Message too long for varint encoding");
  }
}

/**
 * Format a message for Bitcoin signing (BIP-137).
 */
function formatBitcoinMessage(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const lengthBytes = encodeVarInt(messageBytes.length);

  const result = new Uint8Array(
    prefixBytes.length + lengthBytes.length + messageBytes.length
  );
  result.set(prefixBytes, 0);
  result.set(lengthBytes, prefixBytes.length);
  result.set(messageBytes, prefixBytes.length + lengthBytes.length);

  return result;
}

/**
 * Double SHA-256 hash (Bitcoin standard).
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

/**
 * Get Bitcoin address type from BIP-137 header byte.
 */
function getAddressTypeFromHeader(header: number): string {
  if (header >= 27 && header <= 30) return "P2PKH (uncompressed)";
  if (header >= 31 && header <= 34) return "P2PKH (compressed)";
  if (header >= 35 && header <= 38) return "P2SH-P2WPKH (SegWit wrapped)";
  if (header >= 39 && header <= 42) return "P2WPKH (native SegWit)";
  return "Unknown";
}

/**
 * Extract recovery ID from BIP-137 header byte.
 */
function getRecoveryIdFromHeader(header: number): number {
  if (header >= 27 && header <= 30) return header - 27;
  if (header >= 31 && header <= 34) return header - 31;
  if (header >= 35 && header <= 38) return header - 35;
  if (header >= 39 && header <= 42) return header - 39;
  throw new Error(`Invalid BIP-137 header byte: ${header}`);
}

/**
 * Type guard for explicit Clarity type hint objects.
 */
function isTypedValue(value: unknown): value is { type: string; value?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/**
 * Convert a JSON value to a ClarityValue.
 *
 * Supports explicit type hints:
 * - { type: "uint", value: 100 }
 * - { type: "int", value: -50 }
 * - { type: "principal", value: "SP..." }
 * - { type: "ascii", value: "hello" }
 * - { type: "utf8", value: "hello" }
 * - { type: "buff", value: "0x1234" }
 * - { type: "bool", value: true }
 * - { type: "none" }
 * - { type: "some", value: ... }
 * - { type: "list", value: [...] }
 * - { type: "tuple", value: {...} }
 *
 * Implicit conversion:
 * - string -> stringUtf8CV
 * - number -> intCV
 * - boolean -> trueCV/falseCV
 * - null/undefined -> noneCV
 * - array -> listCV
 * - object -> tupleCV
 */
function jsonToClarityValue(value: unknown): ClarityValue {
  if (isTypedValue(value)) {
    switch (value.type) {
      case "uint":
        if (typeof value.value !== "number" && typeof value.value !== "string") {
          throw new Error("uint type requires a numeric value");
        }
        return uintCV(BigInt(value.value));

      case "int":
        if (typeof value.value !== "number" && typeof value.value !== "string") {
          throw new Error("int type requires a numeric value");
        }
        return intCV(BigInt(value.value));

      case "principal":
        if (typeof value.value !== "string") {
          throw new Error("principal type requires a string value");
        }
        return principalCV(value.value);

      case "ascii":
        if (typeof value.value !== "string") {
          throw new Error("ascii type requires a string value");
        }
        return stringAsciiCV(value.value);

      case "utf8":
        if (typeof value.value !== "string") {
          throw new Error("utf8 type requires a string value");
        }
        return stringUtf8CV(value.value);

      case "buff":
      case "buffer": {
        if (typeof value.value !== "string") {
          throw new Error("buff type requires a hex string value");
        }
        const hexStr = value.value.startsWith("0x")
          ? value.value.slice(2)
          : value.value;
        return bufferCV(Uint8Array.from(Buffer.from(hexStr, "hex")));
      }

      case "bool":
        return value.value ? trueCV() : falseCV();

      case "none":
        return noneCV();

      case "some":
        return someCV(jsonToClarityValue(value.value));

      case "list":
        if (!Array.isArray(value.value)) {
          throw new Error("list type requires an array value");
        }
        return listCV(value.value.map(jsonToClarityValue));

      case "tuple": {
        if (typeof value.value !== "object" || value.value === null) {
          throw new Error("tuple type requires an object value");
        }
        const tupleData: { [key: string]: ClarityValue } = {};
        for (const [k, v] of Object.entries(value.value)) {
          tupleData[k] = jsonToClarityValue(v);
        }
        return tupleCV(tupleData);
      }

      default:
        throw new Error(`Unknown type hint: ${value.type}`);
    }
  }

  if (value === null || value === undefined) {
    return noneCV();
  }

  if (typeof value === "boolean") {
    return value ? trueCV() : falseCV();
  }

  if (typeof value === "number") {
    return intCV(BigInt(Math.floor(value)));
  }

  if (typeof value === "string") {
    return stringUtf8CV(value);
  }

  if (Array.isArray(value)) {
    return listCV(value.map(jsonToClarityValue));
  }

  if (typeof value === "object") {
    const tupleData: { [key: string]: ClarityValue } = {};
    for (const [k, v] of Object.entries(value)) {
      tupleData[k] = jsonToClarityValue(v);
    }
    return tupleCV(tupleData);
  }

  throw new Error(`Cannot convert value to ClarityValue: ${typeof value}`);
}

/**
 * Build the standard SIP-018 domain tuple.
 */
function buildDomainCV(name: string, version: string, chainId: number): ClarityValue {
  return tupleCV({
    name: stringAsciiCV(name),
    version: stringAsciiCV(version),
    "chain-id": uintCV(chainId),
  });
}

/**
 * Get the active wallet account or throw a consistent error.
 */
function requireUnlockedWallet() {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();

  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Use wallet/wallet.ts unlock first to enable signing."
    );
  }

  return account;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("signing")
  .description(
    "Message signing: SIP-018 structured data, Stacks messages (SIWS-compatible), and Bitcoin messages (BIP-137)"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// sip018-sign
// ---------------------------------------------------------------------------

program
  .command("sip018-sign")
  .description(
    "Sign structured Clarity data using the SIP-018 standard. " +
      "Creates a signature verifiable both off-chain and on-chain by smart contracts. " +
      "Use cases: meta-transactions, off-chain voting, permits, proving address control. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--message <json>",
    "The structured data to sign as a JSON string (e.g., '{\"amount\":{\"type\":\"uint\",\"value\":100}}')"
  )
  .requiredOption(
    "--domain-name <name>",
    "Application name for domain binding (e.g., 'My App')"
  )
  .requiredOption(
    "--domain-version <version>",
    "Application version for domain binding (e.g., '1.0.0')"
  )
  .action(
    async (opts: {
      message: string;
      domainName: string;
      domainVersion: string;
    }) => {
      try {
        const account = requireUnlockedWallet();

        let messageJson: unknown;
        try {
          messageJson = JSON.parse(opts.message);
        } catch {
          throw new Error("--message must be a valid JSON string");
        }

        if (typeof messageJson !== "object" || messageJson === null || Array.isArray(messageJson)) {
          throw new Error("--message must be a JSON object");
        }

        const chainId = CHAIN_IDS[NETWORK];
        const domainCV = buildDomainCV(opts.domainName, opts.domainVersion, chainId);
        const messageCV = jsonToClarityValue(messageJson);

        const signature = signStructuredData({
          message: messageCV,
          domain: domainCV,
          privateKey: account.privateKey,
        });

        const messageHash = hashStructuredData(messageCV);
        const domainHash = hashStructuredData(domainCV);

        const encodedBytes = encodeStructuredDataBytes({
          message: messageCV,
          domain: domainCV,
        });
        const encodedHex = bytesToHex(encodedBytes);
        const verificationHash = bytesToHex(hashSha256Sync(encodedBytes));

        printJson({
          success: true,
          signature,
          signatureFormat: "RSV (65 bytes hex)",
          signer: account.address,
          network: NETWORK,
          chainId,
          hashes: {
            message: messageHash,
            domain: domainHash,
            encoded: encodedHex,
            verification: verificationHash,
            prefix: SIP018_MSG_PREFIX,
          },
          domain: {
            name: opts.domainName,
            version: opts.domainVersion,
            chainId,
          },
          verificationNote:
            "Use sip018-verify with the 'verification' hash and signature to recover the signer. " +
            "For on-chain verification, use secp256k1-recover? with sha256 of the 'encoded' hash.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// sip018-verify
// ---------------------------------------------------------------------------

program
  .command("sip018-verify")
  .description(
    "Verify a SIP-018 signature and recover the signer's address. " +
      "Takes the verification hash (from sip018-sign or sip018-hash 'verification' field) and the signature, " +
      "then recovers the public key and derives the signer's Stacks address."
  )
  .requiredOption(
    "--message-hash <hash>",
    "The SIP-018 verification hash (from sip018-sign/sip018-hash 'verification' field)"
  )
  .requiredOption(
    "--signature <sig>",
    "The signature in RSV format (65 bytes hex from sip018-sign)"
  )
  .option(
    "--expected-signer <address>",
    "Optional: expected signer address to verify against"
  )
  .action(
    async (opts: {
      messageHash: string;
      signature: string;
      expectedSigner?: string;
    }) => {
      try {
        const recoveredPubKey = publicKeyFromSignatureRsv(
          opts.messageHash,
          opts.signature
        );
        const recoveredAddress = getAddressFromPublicKey(recoveredPubKey, NETWORK);

        const isValid = opts.expectedSigner
          ? recoveredAddress === opts.expectedSigner
          : undefined;

        printJson({
          success: true,
          recoveredPublicKey: recoveredPubKey,
          recoveredAddress,
          network: NETWORK,
          verification: opts.expectedSigner
            ? {
                expectedSigner: opts.expectedSigner,
                isValid,
                message: isValid
                  ? "Signature is valid for the expected signer"
                  : "Signature does NOT match expected signer",
              }
            : undefined,
          note:
            "The recovered address is derived from the public key recovered from the signature. " +
            "For on-chain verification, use secp256k1-recover? and principal-of?.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// sip018-hash
// ---------------------------------------------------------------------------

program
  .command("sip018-hash")
  .description(
    "Compute the SIP-018 message hash without signing. " +
      "Returns the full encoded hash, domain hash, and message hash. " +
      "Useful for preparing data for on-chain verification or multi-sig coordination. " +
      "Does not require an unlocked wallet."
  )
  .requiredOption(
    "--message <json>",
    "The structured data as a JSON string (e.g., '{\"amount\":{\"type\":\"uint\",\"value\":100}}')"
  )
  .requiredOption(
    "--domain-name <name>",
    "Application name (e.g., 'My App')"
  )
  .requiredOption(
    "--domain-version <version>",
    "Application version (e.g., '1.0.0')"
  )
  .option(
    "--chain-id <id>",
    "Optional chain ID (default: 1 for mainnet, 2147483648 for testnet)"
  )
  .action(
    async (opts: {
      message: string;
      domainName: string;
      domainVersion: string;
      chainId?: string;
    }) => {
      try {
        let messageJson: unknown;
        try {
          messageJson = JSON.parse(opts.message);
        } catch {
          throw new Error("--message must be a valid JSON string");
        }

        if (typeof messageJson !== "object" || messageJson === null || Array.isArray(messageJson)) {
          throw new Error("--message must be a JSON object");
        }

        const chainId = opts.chainId
          ? parseInt(opts.chainId, 10)
          : CHAIN_IDS[NETWORK];

        if (isNaN(chainId)) {
          throw new Error("--chain-id must be an integer");
        }

        const domainCV = buildDomainCV(opts.domainName, opts.domainVersion, chainId);
        const messageCV = jsonToClarityValue(messageJson);

        const messageHash = hashStructuredData(messageCV);
        const domainHash = hashStructuredData(domainCV);

        const encodedBytes = encodeStructuredDataBytes({
          message: messageCV,
          domain: domainCV,
        });
        const encodedHex = bytesToHex(encodedBytes);
        const verificationHash = bytesToHex(hashSha256Sync(encodedBytes));

        printJson({
          success: true,
          hashes: {
            message: messageHash,
            domain: domainHash,
            encoded: encodedHex,
            verification: verificationHash,
          },
          hashConstruction: {
            prefix: SIP018_MSG_PREFIX,
            formula: "verification = sha256(prefix || domainHash || messageHash)",
            note: "Use 'verification' hash with sip018-verify. Use 'encoded' with secp256k1-recover? on-chain.",
          },
          domain: {
            name: opts.domainName,
            version: opts.domainVersion,
            chainId,
          },
          network: NETWORK,
          clarityVerification: {
            note: "For on-chain verification, use sha256 of 'encoded' with secp256k1-recover?",
            example: "(secp256k1-recover? (sha256 encoded-data) signature)",
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// stacks-sign
// ---------------------------------------------------------------------------

program
  .command("stacks-sign")
  .description(
    "Sign a plain text message using the Stacks message signing format (SIWS-compatible). " +
      "The message is prefixed with '\\x17Stacks Signed Message:\\n' before hashing. " +
      "Use cases: proving address ownership, authentication, sign-in flows. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--message <text>",
    "The plain text message to sign"
  )
  .action(async (opts: { message: string }) => {
    try {
      const account = requireUnlockedWallet();

      const msgHash = hashMessage(opts.message);
      const msgHashHex = bytesToHex(msgHash);

      const signature = signMessageHashRsv({
        messageHash: msgHashHex,
        privateKey: account.privateKey,
      });

      printJson({
        success: true,
        signature,
        signatureFormat: "RSV (65 bytes hex)",
        signer: account.address,
        network: NETWORK,
        message: {
          original: opts.message,
          prefix: STACKS_MSG_PREFIX,
          prefixHex: bytesToHex(new TextEncoder().encode(STACKS_MSG_PREFIX)),
          hash: msgHashHex,
        },
        verificationNote:
          "Use stacks-verify with the original message and signature to verify. " +
          "Compatible with SIWS (Sign In With Stacks) authentication flows.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// stacks-verify
// ---------------------------------------------------------------------------

program
  .command("stacks-verify")
  .description(
    "Verify a Stacks message signature and recover the signer's address. " +
      "Takes the original message and signature, applies the Stacks prefix, and verifies. " +
      "Compatible with SIWS (Sign In With Stacks) authentication flows."
  )
  .requiredOption(
    "--message <text>",
    "The original plain text message that was signed"
  )
  .requiredOption(
    "--signature <sig>",
    "The signature in RSV format (65 bytes hex from stacks-sign or a Stacks wallet)"
  )
  .option(
    "--expected-signer <address>",
    "Optional: expected signer address to verify against"
  )
  .action(
    async (opts: {
      message: string;
      signature: string;
      expectedSigner?: string;
    }) => {
      try {
        const messageHash = hashMessage(opts.message);
        const messageHashHex = bytesToHex(messageHash);

        const recoveredPubKey = publicKeyFromSignatureRsv(
          messageHashHex,
          opts.signature
        );
        const recoveredAddress = getAddressFromPublicKey(recoveredPubKey, NETWORK);

        const signatureValid = verifyMessageSignatureRsv({
          signature: opts.signature,
          message: opts.message,
          publicKey: recoveredPubKey,
        });

        const signerMatches = opts.expectedSigner
          ? recoveredAddress === opts.expectedSigner
          : undefined;

        const isFullyValid =
          signatureValid && (opts.expectedSigner ? signerMatches : true);

        printJson({
          success: true,
          signatureValid,
          recoveredPublicKey: recoveredPubKey,
          recoveredAddress,
          network: NETWORK,
          message: {
            original: opts.message,
            prefix: STACKS_MSG_PREFIX,
            hash: messageHashHex,
          },
          verification: opts.expectedSigner
            ? {
                expectedSigner: opts.expectedSigner,
                signerMatches,
                isFullyValid,
                message: isFullyValid
                  ? "Signature is valid and matches expected signer"
                  : signatureValid
                    ? "Signature is valid but does NOT match expected signer"
                    : "Signature is invalid",
              }
            : undefined,
          note:
            "The recovered address is derived from the public key recovered from the signature. " +
            "Compatible with SIWS (Sign In With Stacks) authentication flows.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// btc-sign
// ---------------------------------------------------------------------------

program
  .command("btc-sign")
  .description(
    "Sign a plain text message using Bitcoin message signing format (BIP-137). " +
      "Creates a 65-byte signature compatible with most Bitcoin wallets. " +
      "Use cases: proving Bitcoin address ownership, authentication, off-chain verification. " +
      "Requires an unlocked wallet with Bitcoin keys."
  )
  .requiredOption(
    "--message <text>",
    "The plain text message to sign"
  )
  .action(async (opts: { message: string }) => {
    try {
      const account = requireUnlockedWallet();

      if (!account.btcPrivateKey || !account.btcPublicKey) {
        throw new Error(
          "Bitcoin keys not available. Ensure the wallet has Bitcoin key derivation."
        );
      }

      const formattedMsg = formatBitcoinMessage(opts.message);
      const msgHash = doubleSha256(formattedMsg);

      const sigWithRecovery = secp256k1.sign(msgHash, account.btcPrivateKey, {
        prehash: false,
        lowS: true,
        format: "recovered",
      }) as Uint8Array;

      // recovered format: [recoveryId (1 byte), r (32 bytes), s (32 bytes)]
      const recoveryId = sigWithRecovery[0];
      const header = BIP137_HEADER_BASE.P2WPKH + recoveryId;

      const rBytes = sigWithRecovery.slice(1, 33);
      const sBytes = sigWithRecovery.slice(33, 65);

      const bip137Sig = new Uint8Array(65);
      bip137Sig[0] = header;
      bip137Sig.set(rBytes, 1);
      bip137Sig.set(sBytes, 33);

      const signatureHex = hex.encode(bip137Sig);
      const signatureBase64 = Buffer.from(bip137Sig).toString("base64");

      printJson({
        success: true,
        signature: signatureHex,
        signatureBase64,
        signatureFormat: "BIP-137 (65 bytes: 1 header + 32 r + 32 s)",
        signer: account.btcAddress,
        network: NETWORK,
        addressType: "P2WPKH (native SegWit)",
        message: {
          original: opts.message,
          prefix: BITCOIN_MSG_PREFIX,
          prefixHex: hex.encode(new TextEncoder().encode(BITCOIN_MSG_PREFIX)),
          formattedHex: hex.encode(formattedMsg),
          hash: hex.encode(msgHash),
        },
        header: {
          value: header,
          recoveryId,
          addressType: getAddressTypeFromHeader(header),
        },
        verificationNote:
          "Use btc-verify with the original message and signature to verify. " +
          "Base64 format is commonly used by wallets like Electrum and Bitcoin Core.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// btc-verify
// ---------------------------------------------------------------------------

program
  .command("btc-verify")
  .description(
    "Verify a BIP-137 Bitcoin message signature and recover the signer's address. " +
      "Takes the original message and signature (hex or base64), recovers the public key, " +
      "and derives the Bitcoin address. Compatible with signatures from most Bitcoin wallets."
  )
  .requiredOption(
    "--message <text>",
    "The original plain text message that was signed"
  )
  .requiredOption(
    "--signature <sig>",
    "The BIP-137 signature (65 bytes as hex [130 chars] or base64 [88 chars])"
  )
  .option(
    "--expected-signer <address>",
    "Optional: expected signer Bitcoin address to verify against"
  )
  .action(
    async (opts: {
      message: string;
      signature: string;
      expectedSigner?: string;
    }) => {
      try {
        // Parse signature from hex or base64
        let signatureBytes: Uint8Array;

        if (
          opts.signature.length === 130 &&
          /^[0-9a-fA-F]+$/.test(opts.signature)
        ) {
          signatureBytes = hex.decode(opts.signature);
        } else if (
          opts.signature.length === 88 &&
          /^[A-Za-z0-9+/=]+$/.test(opts.signature)
        ) {
          signatureBytes = new Uint8Array(
            Buffer.from(opts.signature, "base64")
          );
        } else {
          try {
            signatureBytes = hex.decode(opts.signature);
          } catch {
            signatureBytes = new Uint8Array(
              Buffer.from(opts.signature, "base64")
            );
          }
        }

        if (signatureBytes.length !== 65) {
          throw new Error(
            `Invalid signature length: ${signatureBytes.length} bytes. Expected 65 bytes.`
          );
        }

        const header = signatureBytes[0];
        const rBytes = signatureBytes.slice(1, 33);
        const sBytes = signatureBytes.slice(33, 65);

        const recoveryId = getRecoveryIdFromHeader(header);
        const addressType = getAddressTypeFromHeader(header);

        const formattedMessage = formatBitcoinMessage(opts.message);
        const messageHash = doubleSha256(formattedMessage);

        const r = BigInt("0x" + hex.encode(rBytes));
        const s = BigInt("0x" + hex.encode(sBytes));

        const sig = new secp256k1.Signature(r, s, recoveryId);
        const recoveredPoint = sig.recoverPublicKey(messageHash);
        const recoveredPubKey = recoveredPoint.toBytes(true); // compressed

        const isValidSig = secp256k1.verify(
          sig.toBytes(),
          messageHash,
          recoveredPubKey,
          { prehash: false }
        );

        // Derive Bitcoin address from recovered public key
        const btc = await import("@scure/btc-signer");
        const btcNetwork =
          NETWORK === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
        const p2wpkh = btc.p2wpkh(recoveredPubKey, btcNetwork);
        const recoveredAddress = p2wpkh.address!;

        const signerMatches = opts.expectedSigner
          ? recoveredAddress === opts.expectedSigner
          : undefined;

        const isFullyValid =
          isValidSig && (opts.expectedSigner ? signerMatches : true);

        printJson({
          success: true,
          signatureValid: isValidSig,
          recoveredPublicKey: hex.encode(recoveredPubKey),
          recoveredAddress,
          network: NETWORK,
          message: {
            original: opts.message,
            prefix: BITCOIN_MSG_PREFIX,
            hash: hex.encode(messageHash),
          },
          header: {
            value: header,
            recoveryId,
            addressType,
          },
          verification: opts.expectedSigner
            ? {
                expectedSigner: opts.expectedSigner,
                signerMatches,
                isFullyValid,
                message: isFullyValid
                  ? "Signature is valid and matches expected signer"
                  : isValidSig
                    ? "Signature is valid but does NOT match expected signer"
                    : "Signature is invalid",
              }
            : undefined,
          note:
            "The recovered address is derived from the public key recovered from the signature. " +
            "BIP-137 signatures are compatible with most Bitcoin wallets (Electrum, Bitcoin Core, etc.).",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// schnorr-sign-digest
// ---------------------------------------------------------------------------

program
  .command("schnorr-sign-digest")
  .description(
    "Sign a raw 32-byte digest with Schnorr (BIP-340) using the wallet's Taproot private key. " +
      "Use for Taproot script-path spending, multisig coordination, or any case where " +
      "you need a BIP-340 Schnorr signature over a pre-computed hash (e.g., BIP-341 sighash). " +
      "WARNING: This signs raw digests that cannot be human-verified — use --confirm-blind-sign after reviewing the digest. " +
      "Returns a 64-byte signature and the x-only public key. Requires an unlocked wallet."
  )
  .requiredOption(
    "--digest <hex>",
    "32-byte hex-encoded digest to sign (e.g., BIP-341 transaction sighash)"
  )
  .option(
    "--aux-rand <hex>",
    "Optional 32-byte hex auxiliary randomness for BIP-340 (improves side-channel resistance)"
  )
  .option(
    "--confirm-blind-sign",
    "Confirm you have reviewed the digest and accept the risk of signing a raw hash"
  )
  .action(
    async (opts: {
      digest: string;
      auxRand?: string;
      confirmBlindSign?: boolean;
    }) => {
      try {
        // Validate digest format
        if (opts.digest.length !== 64 || !/^[0-9a-fA-F]+$/.test(opts.digest)) {
          throw new Error(
            "--digest must be exactly 64 hex characters (32 bytes)"
          );
        }

        // Validate aux-rand format if provided
        if (
          opts.auxRand &&
          (opts.auxRand.length !== 64 || !/^[0-9a-fA-F]+$/.test(opts.auxRand))
        ) {
          throw new Error(
            "--aux-rand must be exactly 64 hex characters (32 bytes)"
          );
        }

        // Safety gate: require explicit confirmation before signing a raw digest
        if (!opts.confirmBlindSign) {
          printJson({
            warning:
              "schnorr-sign-digest signs a raw 32-byte digest that cannot be decoded or human-verified. " +
              "If an attacker controls the digest value, they could trick you into signing a malicious " +
              "transaction sighash or other sensitive data.",
            digestToReview: opts.digest,
            instructions:
              "Review the digest above. If you trust its origin and intent, re-call schnorr-sign-digest " +
              "with the same parameters plus --confirm-blind-sign to proceed with signing.",
          });
          return;
        }

        const account = requireUnlockedWallet();

        if (!account.taprootPrivateKey || !account.taprootPublicKey) {
          throw new Error(
            "Taproot keys not available. Ensure the wallet has Taproot key derivation."
          );
        }

        if (!account.taprootAddress) {
          throw new Error(
            "Taproot address not available for this account."
          );
        }

        const digestBytes = hex.decode(opts.digest);
        const auxBytes = opts.auxRand ? hex.decode(opts.auxRand) : undefined;

        // Sign with Schnorr (BIP-340)
        const signature = schnorr.sign(
          digestBytes,
          account.taprootPrivateKey,
          auxBytes
        );

        const xOnlyPubkey = account.taprootPublicKey;

        printJson({
          success: true,
          signature: hex.encode(signature),
          publicKey: hex.encode(xOnlyPubkey),
          address: account.taprootAddress,
          network: NETWORK,
          signatureFormat: "BIP-340 Schnorr (64 bytes)",
          publicKeyFormat: "x-only (32 bytes)",
          note:
            "For Taproot script-path spending, append sighash type byte if not SIGHASH_DEFAULT (0x00). " +
            "Use this signature with OP_CHECKSIGADD for multisig witness assembly.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// schnorr-verify-digest
// ---------------------------------------------------------------------------

program
  .command("schnorr-verify-digest")
  .description(
    "Verify a BIP-340 Schnorr signature over a 32-byte digest. " +
      "Takes the digest, signature, and public key, returns whether the signature is valid. " +
      "Use for verifying Taproot signatures from other agents in multisig coordination."
  )
  .requiredOption(
    "--digest <hex>",
    "32-byte hex-encoded digest that was signed"
  )
  .requiredOption(
    "--signature <hex>",
    "64-byte hex-encoded BIP-340 Schnorr signature"
  )
  .requiredOption(
    "--public-key <hex>",
    "32-byte hex-encoded x-only public key of the signer"
  )
  .action(
    async (opts: {
      digest: string;
      signature: string;
      publicKey: string;
    }) => {
      try {
        // Validate inputs
        if (opts.digest.length !== 64 || !/^[0-9a-fA-F]+$/.test(opts.digest)) {
          throw new Error(
            "--digest must be exactly 64 hex characters (32 bytes)"
          );
        }
        if (
          opts.signature.length !== 128 ||
          !/^[0-9a-fA-F]+$/.test(opts.signature)
        ) {
          throw new Error(
            "--signature must be exactly 128 hex characters (64 bytes)"
          );
        }
        if (
          opts.publicKey.length !== 64 ||
          !/^[0-9a-fA-F]+$/.test(opts.publicKey)
        ) {
          throw new Error(
            "--public-key must be exactly 64 hex characters (32 bytes)"
          );
        }

        const digestBytes = hex.decode(opts.digest);
        const signatureBytes = hex.decode(opts.signature);
        const publicKeyBytes = hex.decode(opts.publicKey);

        // Verify the Schnorr signature
        const isValid = schnorr.verify(
          signatureBytes,
          digestBytes,
          publicKeyBytes
        );

        printJson({
          success: true,
          isValid,
          digest: opts.digest,
          signature: opts.signature,
          publicKey: opts.publicKey,
          message: isValid
            ? "Signature is valid for the given digest and public key"
            : "Signature is INVALID",
          note:
            "BIP-340 Schnorr verification. Use for validating signatures in Taproot multisig coordination.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
