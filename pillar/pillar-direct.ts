#!/usr/bin/env bun
/**
 * Pillar skill CLI — Agent-signed direct mode
 * Manages a local secp256k1 signing keypair, signs SIP-018 structured data
 * locally, and submits directly to the Pillar backend API. No browser needed.
 * Gas is sponsored by the backend.
 *
 * Usage: bun run pillar/pillar-direct.ts <subcommand> [options]
 */

import { Command } from "commander";
import crypto from "crypto";
import {
  tupleCV,
  stringAsciiCV,
  uintCV,
  principalCV,
  noneCV,
  trueCV,
  falseCV,
} from "@stacks/transactions";
import { getPillarApi } from "../src/lib/services/pillar-api.service.js";
import {
  getSigningKeyService,
  generateAuthId,
  type SigAuth,
} from "../src/lib/services/signing-key.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { PILLAR_API_KEY } from "../src/lib/config/pillar.js";
import { formatStx } from "../src/lib/utils/formatting.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAINNET_SBTC_TOKEN =
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic password from PILLAR_API_KEY.
 * Allows auto-unlock of signing keys after restarts without user input.
 */
function getDerivedPassword(): string {
  const secret = PILLAR_API_KEY || "pillar-direct-default";
  return crypto
    .createHash("sha256")
    .update(`pillar-agent-signing-key:${secret}`)
    .digest("hex");
}

/**
 * Get active signing session, auto-unlocking if needed.
 */
async function requireActiveKey() {
  const keyService = getSigningKeyService();
  let session = keyService.getActiveKey();

  if (!session) {
    const keys = await keyService.listKeys();
    if (keys.length === 0) {
      throw new Error(
        "No signing key found. Use 'direct-create-wallet' to create one."
      );
    }

    // Prefer keys with an actual wallet address (not "pending")
    const sortedKeys = [...keys].sort((a, b) => {
      const aReady = a.smartWallet !== "pending" ? 0 : 1;
      const bReady = b.smartWallet !== "pending" ? 0 : 1;
      return aReady - bReady;
    });

    const password = getDerivedPassword();
    let unlocked = false;
    for (const key of sortedKeys) {
      try {
        await keyService.unlock(key.id, password);
        unlocked = true;
        break;
      } catch {
        // Wrong password for this key, try next
      }
    }

    if (!unlocked) {
      throw new Error(
        "Signing key locked and auto-unlock failed. Set PILLAR_API_KEY environment variable or use 'key-unlock' with your password."
      );
    }

    session = keyService.getActiveKey();
    if (!session) {
      throw new Error("Failed to unlock signing key.");
    }
  }

  return { keyService, session };
}

/**
 * Format sig-auth for the Pillar backend API (ensures 0x prefix).
 */
function formatSigAuthForApi(sigAuth: SigAuth) {
  return {
    authId: sigAuth.authId,
    signature: sigAuth.signature.startsWith("0x")
      ? sigAuth.signature
      : "0x" + sigAuth.signature,
    pubkey: sigAuth.pubkey.startsWith("0x")
      ? sigAuth.pubkey
      : "0x" + sigAuth.pubkey,
  };
}

/**
 * Guard that returns an error object if not on mainnet.
 */
function requireMainnetCheck(): { error: string; network: string } | null {
  if (NETWORK !== "mainnet") {
    return {
      error: "Pillar Direct tools are only available on mainnet",
      network: NETWORK,
    };
  }
  return null;
}

/**
 * Extract wallet name from contract address.
 */
function getWalletName(contractAddress: string): string {
  return contractAddress.split(".")[1] || contractAddress;
}

/**
 * Resolve a recipient identifier to a Stacks address.
 */
async function resolveRecipientAddress(
  api: ReturnType<typeof getPillarApi>,
  to: string,
  recipientType: string
): Promise<string> {
  if (
    recipientType === "address" ||
    to.startsWith("SP") ||
    to.startsWith("ST")
  ) {
    return to;
  }

  if (recipientType === "wallet") {
    const walletLookup = await api.get<{
      success: boolean;
      data: { contractAddress: string } | null;
    }>(`/api/smart-wallet/${to}`);
    if (!walletLookup.data?.contractAddress) {
      throw new Error(`Pillar wallet "${to}" not found.`);
    }
    return walletLookup.data.contractAddress;
  }

  // BNS name resolution
  const bnsName = to.endsWith(".btc") ? to : `${to}.btc`;
  const bnsLookup = await api.get<{
    success: boolean;
    data: { address: string } | null;
  }>("/api/bns/resolve", { name: bnsName });
  if (!bnsLookup.data?.address) {
    throw new Error(`BNS name "${bnsName}" could not be resolved.`);
  }
  return bnsLookup.data.address;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("pillar-direct")
  .description(
    "Pillar smart wallet agent-signed direct operations: key management, boost, unwind, supply, send, stacking, and DCA. Mainnet-only."
  )
  .version("0.1.0");

// ===========================================================================
// Key Management
// ===========================================================================

// ---------------------------------------------------------------------------
// key-generate
// ---------------------------------------------------------------------------

program
  .command("key-generate")
  .description(
    "Generate a new secp256k1 signing keypair for Pillar direct operations. " +
      "Returns the compressed public key (33 bytes hex)."
  )
  .option(
    "--smart-wallet <contractId>",
    "Smart wallet contract ID this key is for (e.g. SP....my-wallet). Use 'pending' if creating a new wallet.",
    "pending"
  )
  .action(async (opts: { smartWallet: string }) => {
    try {
      const keyService = getSigningKeyService();
      const password = getDerivedPassword();
      const { keyId, pubkey } = await keyService.generateKey(
        password,
        opts.smartWallet
      );

      printJson({
        success: true,
        keyId,
        pubkey,
        smartWallet: opts.smartWallet,
        note: "Pubkey generated. An admin must propose and confirm this pubkey on the smart wallet contract before it can sign operations.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// key-unlock
// ---------------------------------------------------------------------------

program
  .command("key-unlock")
  .description(
    "Unlock a signing key for Pillar direct operations. " +
      "Uses auto-derived password. Usually not needed — tools auto-unlock on first use."
  )
  .option(
    "--key-id <id>",
    "The signing key ID to unlock. Unlocks first stored key if omitted."
  )
  .action(async (opts: { keyId?: string }) => {
    try {
      const keyService = getSigningKeyService();
      const password = getDerivedPassword();

      let targetKeyId = opts.keyId;
      if (!targetKeyId) {
        const keys = await keyService.listKeys();
        if (keys.length === 0) {
          throw new Error("No signing keys found.");
        }
        targetKeyId = keys[0].id;
      }

      await keyService.unlock(targetKeyId, password);
      const session = keyService.getActiveKey();

      printJson({
        success: true,
        message: "Signing key unlocked.",
        keyId: targetKeyId,
        pubkey: session!.pubkey,
        smartWallet: session!.smartWallet,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// key-lock
// ---------------------------------------------------------------------------

program
  .command("key-lock")
  .description("Lock the signing key, clearing sensitive data from memory.")
  .action(() => {
    try {
      const keyService = getSigningKeyService();
      keyService.lock();

      printJson({
        success: true,
        message: "Signing key locked.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// key-info
// ---------------------------------------------------------------------------

program
  .command("key-info")
  .description(
    "Show signing key info: pubkey, smart wallet, lock status, and all stored keys."
  )
  .action(async () => {
    try {
      const keyService = getSigningKeyService();
      const session = keyService.getActiveKey();
      const keys = await keyService.listKeys();

      printJson({
        unlocked: session !== null,
        activeKey: session
          ? {
              keyId: session.keyId,
              pubkey: session.pubkey,
              smartWallet: session.smartWallet,
            }
          : null,
        storedKeys: keys.map((k) => ({
          keyId: k.id,
          pubkey: k.pubkey,
          smartWallet: k.smartWallet,
          createdAt: k.createdAt,
        })),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ===========================================================================
// Direct Operations
// ===========================================================================

// ---------------------------------------------------------------------------
// direct-boost
// ---------------------------------------------------------------------------

program
  .command("direct-boost")
  .description(
    "Create or increase a leveraged sBTC position (up to 1.5x). " +
      "Agent-signed, no browser needed. Backend sponsors gas."
  )
  .requiredOption("--sbtc-amount <sats>", "sBTC amount in sats to supply as collateral")
  .requiredOption("--aeusdc-to-borrow <amount>", "aeUSDC amount to borrow (6 decimals)")
  .requiredOption(
    "--min-sbtc-from-swap <sats>",
    "Min sBTC from swap in sats (slippage protection)"
  )
  .action(
    async (opts: {
      sbtcAmount: string;
      aeuscdToBorrow: string;
      minSbtcFromSwap: string;
    }) => {
      try {
        const guard = requireMainnetCheck();
        if (guard) {
          printJson(guard);
          return;
        }

        const sbtcAmount = parseInt(opts.sbtcAmount, 10);
        const aeUsdcToBorrow = parseInt((opts as Record<string, string>)["aeusdc-to-borrow"] || opts.aeuscdToBorrow, 10);
        const minSbtcFromSwap = parseInt(opts.minSbtcFromSwap, 10);

        const { keyService, session } = await requireActiveKey();
        const authId = generateAuthId();

        const structuredData = tupleCV({
          topic: stringAsciiCV("pillar-boost"),
          "auth-id": uintCV(authId),
          "sbtc-amount": uintCV(sbtcAmount),
          "aeusdc-to-borrow": uintCV(aeUsdcToBorrow),
          "min-sbtc-from-swap": uintCV(minSbtcFromSwap),
        });

        const sigAuth = keyService.sign(structuredData, authId);
        const api = getPillarApi();
        const result = await api.post<{
          success: boolean;
          data: { txId: string };
        }>("/api/pillar/boost", {
          walletAddress: session.smartWallet,
          sbtcAmount,
          aeUsdcToBorrow,
          minSbtcFromSwap,
          sigAuth: formatSigAuthForApi(sigAuth),
        });

        printJson({
          success: true,
          operation: "pillar-boost",
          txId: result.data.txId,
          explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
          walletAddress: session.smartWallet,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// direct-unwind
// ---------------------------------------------------------------------------

program
  .command("direct-unwind")
  .description(
    "Close or reduce your leveraged sBTC position. Agent-signed, no browser needed."
  )
  .requiredOption("--sbtc-to-swap <sats>", "sBTC to swap to aeUSDC for repayment (sats)")
  .requiredOption("--sbtc-to-withdraw <sats>", "sBTC to withdraw after repayment (sats)")
  .requiredOption(
    "--min-aeusdc-from-swap <amount>",
    "Min aeUSDC from swap (6 decimals, slippage protection)"
  )
  .action(
    async (opts: {
      sbtcToSwap: string;
      sbtcToWithdraw: string;
      minAeusdcFromSwap: string;
    }) => {
      try {
        const guard = requireMainnetCheck();
        if (guard) {
          printJson(guard);
          return;
        }

        const sbtcToSwap = parseInt(opts.sbtcToSwap, 10);
        const sbtcToWithdraw = parseInt(opts.sbtcToWithdraw, 10);
        const minAeUsdcFromSwap = parseInt(opts.minAeusdcFromSwap, 10);

        const { keyService, session } = await requireActiveKey();
        const authId = generateAuthId();

        const structuredData = tupleCV({
          topic: stringAsciiCV("pillar-unwind"),
          "auth-id": uintCV(authId),
          "sbtc-to-swap": uintCV(sbtcToSwap),
          "sbtc-to-withdraw": uintCV(sbtcToWithdraw),
          "min-aeusdc-from-swap": uintCV(minAeUsdcFromSwap),
        });

        const sigAuth = keyService.sign(structuredData, authId);
        const api = getPillarApi();
        const result = await api.post<{
          success: boolean;
          data: { txId: string };
        }>("/api/pillar/unwind", {
          walletAddress: session.smartWallet,
          sbtcToSwap,
          sbtcToWithdraw,
          minAeUsdcFromSwap,
          sigAuth: formatSigAuthForApi(sigAuth),
        });

        printJson({
          success: true,
          operation: "pillar-unwind",
          txId: result.data.txId,
          explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
          walletAddress: session.smartWallet,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// direct-supply
// ---------------------------------------------------------------------------

program
  .command("direct-supply")
  .description(
    "Supply sBTC to Zest Protocol for yield. No leverage, no liquidation risk. " +
      "Agent-signed, no browser needed."
  )
  .requiredOption("--sbtc-amount <sats>", "sBTC amount in sats to supply")
  .action(async (opts: { sbtcAmount: string }) => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const sbtcAmount = parseInt(opts.sbtcAmount, 10);

      const { keyService, session } = await requireActiveKey();
      const authId = generateAuthId();

      const structuredData = tupleCV({
        topic: stringAsciiCV("pillar-add-collateral"),
        "auth-id": uintCV(authId),
        "sbtc-amount": uintCV(sbtcAmount),
      });

      const sigAuth = keyService.sign(structuredData, authId);
      const api = getPillarApi();
      const result = await api.post<{
        success: boolean;
        data: { txId: string };
      }>("/api/pillar/add-collateral", {
        walletAddress: session.smartWallet,
        sbtcAmount,
        sigAuth: formatSigAuthForApi(sigAuth),
      });

      printJson({
        success: true,
        operation: "pillar-add-collateral",
        txId: result.data.txId,
        explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
        walletAddress: session.smartWallet,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-send
// ---------------------------------------------------------------------------

program
  .command("direct-send")
  .description(
    "Send sBTC from your Pillar smart wallet. Agent-signed, no browser needed. " +
      "Supports BNS names, wallet names, or Stacks addresses."
  )
  .requiredOption(
    "--to <recipient>",
    "Recipient: BNS name (muneeb.btc), Pillar wallet name, or Stacks address (SP...)"
  )
  .requiredOption("--amount <satoshis>", "Amount in satoshis")
  .option(
    "--recipient-type <type>",
    "Type of recipient: bns (default), wallet, or address",
    "bns"
  )
  .action(
    async (opts: { to: string; amount: string; recipientType: string }) => {
      try {
        const guard = requireMainnetCheck();
        if (guard) {
          printJson(guard);
          return;
        }

        const amount = parseInt(opts.amount, 10);

        const { keyService, session } = await requireActiveKey();
        const api = getPillarApi();

        const resolvedAddress = await resolveRecipientAddress(
          api,
          opts.to,
          opts.recipientType
        );

        const authId = generateAuthId();
        const structuredData = tupleCV({
          topic: stringAsciiCV("sip010-transfer"),
          "auth-id": uintCV(authId),
          amount: uintCV(amount),
          recipient: principalCV(resolvedAddress),
          memo: noneCV(),
          sip010: principalCV(MAINNET_SBTC_TOKEN),
        });

        const sigAuth = keyService.sign(structuredData, authId);
        const result = await api.post<{
          success: boolean;
          data: { txId: string };
        }>("/api/smart-wallet/sip010-transfer", {
          walletAddress: session.smartWallet,
          amount,
          recipient: resolvedAddress,
          sip010: MAINNET_SBTC_TOKEN,
          tokenName: "sbtc-token",
          sigAuth: formatSigAuthForApi(sigAuth),
        });

        printJson({
          success: true,
          operation: "sip010-transfer",
          txId: result.data.txId,
          explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
          walletAddress: session.smartWallet,
          to: opts.to,
          resolvedAddress,
          amount,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// direct-auto-compound
// ---------------------------------------------------------------------------

program
  .command("direct-auto-compound")
  .description(
    "Configure auto-compound for your Pillar wallet. Agent-signed, no browser needed."
  )
  .requiredOption("--enabled <bool>", "Enable (true) or disable (false) auto-compound")
  .requiredOption("--min-sbtc <sats>", "Minimum sBTC to keep in wallet (sats)")
  .requiredOption(
    "--trigger <sats>",
    "sBTC amount above minimum that triggers auto-compound (sats)"
  )
  .action(
    async (opts: { enabled: string; minSbtc: string; trigger: string }) => {
      try {
        const guard = requireMainnetCheck();
        if (guard) {
          printJson(guard);
          return;
        }

        const enabled = opts.enabled === "true" || opts.enabled === "1";
        const minSbtc = parseInt(opts.minSbtc, 10);
        const trigger = parseInt(opts.trigger, 10);

        const { keyService, session } = await requireActiveKey();
        const authId = generateAuthId();

        const structuredData = tupleCV({
          topic: stringAsciiCV("set-keeper-auto-compound"),
          "auth-id": uintCV(authId),
          enabled: enabled ? trueCV() : falseCV(),
          "min-sbtc": uintCV(minSbtc),
          trigger: uintCV(trigger),
        });

        const sigAuth = keyService.sign(structuredData, authId);
        const api = getPillarApi();
        const result = await api.post<{
          success: boolean;
          data: { txId: string };
        }>("/api/pillar/set-auto-compound", {
          walletAddress: session.smartWallet,
          enabled,
          minSbtc,
          trigger,
          sigAuth: formatSigAuthForApi(sigAuth),
        });

        printJson({
          success: true,
          operation: "set-keeper-auto-compound",
          txId: result.data.txId,
          explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
          walletAddress: session.smartWallet,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// direct-position
// ---------------------------------------------------------------------------

program
  .command("direct-position")
  .description(
    "View your Pillar smart wallet balances (STX, sBTC, aeUSDC) and Zest position. " +
      "No signing needed — reads on-chain data."
  )
  .action(async () => {
    try {
      const { session } = await requireActiveKey();
      const api = getPillarApi();

      const walletName = getWalletName(session.smartWallet);

      // Check wallet status in backend
      let walletStatus: string | null = null;
      try {
        const walletInfo = await api.get<{
          success: boolean;
          data: { status: string; contractAddress: string } | null;
        }>(`/api/smart-wallet/${walletName}`);
        walletStatus = walletInfo.data?.status || null;
      } catch {
        // Wallet not found in backend
      }

      if (!walletStatus || walletStatus === "pending_init") {
        printJson({
          success: true,
          walletAddress: session.smartWallet,
          status: walletStatus || "unknown",
          message:
            "Wallet is still being onboarded. The on-chain deployment may be confirmed " +
            "but the backend hasn't synced yet. Try again in a minute.",
        });
        return;
      }

      // Fetch on-chain balances from Hiro API
      const hiro = getHiroApi(NETWORK);
      let stxBalance = "0";
      let sbtcBalanceSats = 0;
      let aeusdcBalance = 0;
      let balanceApiError: string | null = null;

      try {
        const balances = await hiro.getAccountBalances(session.smartWallet);

        stxBalance = (balances as { stx?: { balance?: string } }).stx?.balance || "0";

        const fungibleTokens = (balances as { fungible_tokens?: Record<string, { balance?: string }> }).fungible_tokens || {};

        const sbtcKey = Object.keys(fungibleTokens).find((k) =>
          k.includes("sbtc-token")
        );
        if (sbtcKey) {
          sbtcBalanceSats = parseInt(fungibleTokens[sbtcKey].balance || "0");
        }

        const aeusdcKey = Object.keys(fungibleTokens).find((k) =>
          k.includes("token-aeusdc")
        );
        if (aeusdcKey) {
          aeusdcBalance = parseInt(fungibleTokens[aeusdcKey].balance || "0");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        balanceApiError = `Hiro API unavailable: ${errMsg}`;
      }

      const stxMicro = BigInt(stxBalance);
      const stxFormatted = formatStx(stxMicro);

      const walletBalances: Record<string, unknown> = {
        stx: stxFormatted,
        stxMicroStx: stxBalance,
        sbtcSats: sbtcBalanceSats,
        sbtcBtc: sbtcBalanceSats / 1e8,
        aeusdcRaw: aeusdcBalance,
        aeusdcFormatted: (aeusdcBalance / 1e6).toFixed(2),
        ...(balanceApiError ? { apiError: balanceApiError } : {}),
      };

      // Fetch Zest position
      let position: Record<string, unknown> | null = null;
      try {
        const unwindQuote = await api.get<{
          success: boolean;
          data: {
            collateralSats: number;
            collateralBtc: number;
            collateralUsd: number;
            borrowedAeUsdc: number;
            borrowedUsd: number;
            btcPrice: number;
            canUnwind: boolean;
          };
        }>("/api/pillar/unwind-quote", {
          walletAddress: session.smartWallet,
        });

        position = unwindQuote.data as Record<string, unknown>;
      } catch {
        // No position yet
      }

      printJson({
        success: true,
        walletAddress: session.smartWallet,
        status: walletStatus,
        balances: walletBalances,
        zestPosition: position || {
          collateralSats: 0,
          borrowedAeUsdc: 0,
          message: "No Zest position yet. Supply sBTC or boost to get started.",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-withdraw-collateral
// ---------------------------------------------------------------------------

program
  .command("direct-withdraw-collateral")
  .description(
    "Withdraw sBTC collateral from Zest. Agent-signed, no browser needed."
  )
  .requiredOption("--sbtc-amount <sats>", "sBTC amount in sats to withdraw")
  .action(async (opts: { sbtcAmount: string }) => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const sbtcAmount = parseInt(opts.sbtcAmount, 10);

      const { keyService, session } = await requireActiveKey();
      const authId = generateAuthId();

      const structuredData = tupleCV({
        topic: stringAsciiCV("pillar-withdraw-collateral"),
        "auth-id": uintCV(authId),
        "sbtc-amount": uintCV(sbtcAmount),
      });

      const sigAuth = keyService.sign(structuredData, authId);
      const api = getPillarApi();
      const result = await api.post<{
        success: boolean;
        data: { txId: string };
      }>("/api/pillar/withdraw-collateral", {
        walletAddress: session.smartWallet,
        sbtcAmount,
        sigAuth: formatSigAuthForApi(sigAuth),
      });

      printJson({
        success: true,
        operation: "pillar-withdraw-collateral",
        txId: result.data.txId,
        explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
        walletAddress: session.smartWallet,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-add-admin
// ---------------------------------------------------------------------------

program
  .command("direct-add-admin")
  .description(
    "Add a backup admin address to your Pillar smart wallet. Agent-signed, no browser needed."
  )
  .requiredOption("--new-admin <address>", "Stacks address (SP...) to add as backup admin")
  .action(async (opts: { newAdmin: string }) => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const { keyService, session } = await requireActiveKey();
      const authId = generateAuthId();

      const structuredData = tupleCV({
        topic: stringAsciiCV("add-admin"),
        "auth-id": uintCV(authId),
        "new-admin": principalCV(opts.newAdmin),
      });

      const sigAuth = keyService.sign(structuredData, authId);
      const api = getPillarApi();
      const result = await api.post<{
        success: boolean;
        data: { txId: string };
      }>("/api/smart-wallet/add-admin", {
        walletAddress: session.smartWallet,
        newAdmin: opts.newAdmin,
        sigAuth: formatSigAuthForApi(sigAuth),
      });

      printJson({
        success: true,
        operation: "add-admin",
        txId: result.data.txId,
        explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
        walletAddress: session.smartWallet,
        newAdmin: opts.newAdmin,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-create-wallet
// ---------------------------------------------------------------------------

program
  .command("direct-create-wallet")
  .description(
    "Create a new Pillar smart wallet for agent direct operations. " +
      "Generates a signing keypair, unlocks it, and deploys a new smart wallet. " +
      "Backend deploys the contract and calls onboard() in background (~20-30s)."
  )
  .requiredOption(
    "--wallet-name <name>",
    "Wallet name (3-20 chars, lowercase letters, numbers, hyphens)"
  )
  .option(
    "--referred-by <contractId>",
    "Contract address of the referring wallet",
    "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.beta-v2-wallet"
  )
  .action(async (opts: { walletName: string; referredBy: string }) => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const api = getPillarApi();
      const password = getDerivedPassword();

      // Check name availability
      const nameCheck = await api.get<{
        success: boolean;
        data: {
          name: string;
          available: boolean;
          reason?: string;
          message?: string;
          contractName?: string;
        };
      }>("/api/smart-wallet/check-name", { name: opts.walletName });

      if (!nameCheck.data.available) {
        printJson({
          success: false,
          error:
            nameCheck.data.message ||
            `Wallet name "${opts.walletName}" is not available.`,
          reason: nameCheck.data.reason,
        });
        return;
      }

      // Generate signing keypair
      const keyService = getSigningKeyService();
      const { keyId, pubkey } = await keyService.generateKey(password, "pending");

      // Unlock it
      await keyService.unlock(keyId, password);

      // Deploy wallet with this pubkey
      const pubkeyPrefixed = pubkey.startsWith("0x") ? pubkey : "0x" + pubkey;

      const safeWalletName = opts.walletName.replace(/-/g, "");
      const email = `${safeWalletName}@agent.pillarbtc.com`;
      const privyWalletAddress = "0x0000000000000000000000000000000000000000";

      const result = await api.post<{
        success: boolean;
        data: {
          walletName: string;
          contractName: string;
          contractAddress: string;
          deployTxId: string;
          initTxId: string | null;
          status: string;
        };
      }>("/api/smart-wallet/deploy", {
        walletName: opts.walletName,
        ownerPubkey: pubkeyPrefixed,
        email,
        privyWalletAddress,
        referredBy: opts.referredBy,
      });

      // Associate signing key with the new wallet
      await keyService.updateKeyWallet(keyId, result.data.contractAddress);

      printJson({
        success: true,
        operation: "create-wallet",
        keyId,
        pubkey: pubkeyPrefixed,
        walletName: result.data.walletName,
        contractName: result.data.contractName,
        contractAddress: result.data.contractAddress,
        deployTxId: result.data.deployTxId,
        explorerUrl: getExplorerTxUrl(result.data.deployTxId, NETWORK),
        status: result.data.status,
        note:
          "Signing key generated, unlocked, and wallet deployed. " +
          "Backend is calling onboard() in background (~20-30s). " +
          "Once status changes to deployed, direct operations are ready.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ===========================================================================
// DCA Operations
// ===========================================================================

// ---------------------------------------------------------------------------
// direct-dca-invite
// ---------------------------------------------------------------------------

program
  .command("direct-dca-invite")
  .description(
    "Invite a DCA partner by email or wallet address. Uses wallet address from signing key session."
  )
  .requiredOption(
    "--partner <email-or-address>",
    "Partner's email address or Stacks wallet address (SP...)"
  )
  .action(async (opts: { partner: string }) => {
    try {
      const { session } = await requireActiveKey();
      const isEmail = opts.partner.includes("@");

      const api = getPillarApi();
      const result = await api.post<{
        partnershipId: string;
        status: string;
        inviteLink?: string;
      }>("/api/dca-partner/invite", {
        walletAddress: session.smartWallet,
        ...(isEmail
          ? { partnerEmail: opts.partner }
          : { partnerWalletAddress: opts.partner }),
      });

      printJson({
        success: true,
        partnershipId: result.partnershipId,
        status: result.status,
        message: isEmail
          ? `Invite sent to ${opts.partner}. They'll receive an email with a link to accept.`
          : `Partnership invite sent to ${opts.partner}.`,
        ...(result.inviteLink ? { inviteLink: result.inviteLink } : {}),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-dca-partners
// ---------------------------------------------------------------------------

program
  .command("direct-dca-partners")
  .description("View your DCA partners and weekly status.")
  .action(async () => {
    try {
      const { session } = await requireActiveKey();

      const api = getPillarApi();
      const result = await api.get<{
        partnerships: Array<{
          partnershipId: string;
          partnerName?: string;
          partnerAddress: string;
          streak: number;
          pnl?: number;
          myStatus: string;
          partnerStatus: string;
          status: string;
        }>;
        pendingInvites: Array<{
          partnershipId: string;
          partnerEmail?: string;
          partnerAddress?: string;
          direction: string;
        }>;
      }>("/api/dca-partner/my-partners", { walletAddress: session.smartWallet });

      const active = result.partnerships.filter((p) => p.status === "active");
      const pending = result.pendingInvites || [];

      printJson({
        success: true,
        activePartnerships: active.map((p) => ({
          partnershipId: p.partnershipId,
          partner: p.partnerName || p.partnerAddress,
          streak: p.streak,
          pnl: p.pnl,
          myStatus: p.myStatus,
          partnerStatus: p.partnerStatus,
        })),
        pendingInvites: pending.length,
        pendingDetails: pending.map((p) => ({
          partnershipId: p.partnershipId,
          partner: p.partnerEmail || p.partnerAddress,
          direction: p.direction,
        })),
        message:
          active.length > 0
            ? `${active.length} active partnership${active.length > 1 ? "s" : ""}, ${pending.length} pending invite${pending.length !== 1 ? "s" : ""}`
            : `No active partnerships. ${pending.length} pending invite${pending.length !== 1 ? "s" : ""}. Use 'direct-dca-invite' to invite a partner.`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-dca-leaderboard
// ---------------------------------------------------------------------------

program
  .command("direct-dca-leaderboard")
  .description("View the DCA streak leaderboard.")
  .action(async () => {
    try {
      const { session } = await requireActiveKey();

      const api = getPillarApi();
      const result = await api.get<{
        leaderboard: Array<{
          rank: number;
          partnerNames: string[];
          streak: number;
          pnl?: number;
          isUser?: boolean;
        }>;
        userEntry?: {
          rank: number;
          partnerName: string;
          streak: number;
          pnl?: number;
        };
      }>("/api/dca-partner/leaderboard", { walletAddress: session.smartWallet });

      printJson({
        success: true,
        leaderboard: result.leaderboard.map((entry) => ({
          rank: entry.rank,
          partners: entry.partnerNames.join(" & "),
          streak: entry.streak,
          pnl: entry.pnl,
          isYou: entry.isUser || false,
        })),
        yourRank: result.userEntry
          ? {
              rank: result.userEntry.rank,
              partner: result.userEntry.partnerName,
              streak: result.userEntry.streak,
              pnl: result.userEntry.pnl,
            }
          : null,
        message: result.userEntry
          ? `You're ranked #${result.userEntry.rank} with a ${result.userEntry.streak}-week streak with ${result.userEntry.partnerName}.`
          : "You don't have an active partnership on the leaderboard yet. Use 'direct-dca-invite' to get started.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-dca-status
// ---------------------------------------------------------------------------

interface DcaScheduleInfo {
  id: string;
  totalSbtcAmount: number;
  chunkSizeSats: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  status: string;
  btcPriceAtCreation: number | null;
  createdAt: number;
  completedAt: number | null;
}

interface DcaChunkInfo {
  id: string;
  chunkIndex: number;
  sbtcAmount: number;
  status: string;
  scheduledAt: number;
  executedAt: number | null;
  txId: string | null;
  retryCount: number;
  errorMessage: string | null;
}

interface DcaStatusResult {
  schedule: DcaScheduleInfo;
  chunks: DcaChunkInfo[];
  allSchedules?: { schedule: DcaScheduleInfo; chunks: DcaChunkInfo[] }[];
  activeCount?: number;
  maxSchedules?: number;
}

function formatDcaSchedule(s: DcaScheduleInfo, chunks: DcaChunkInfo[]) {
  const pendingChunks = chunks.filter(
    (c) => c.status === "pending" || c.status === "executing"
  ).length;
  const nextPending = chunks
    .filter((c) => c.status === "pending")
    .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
  const nextExecution = nextPending
    ? new Date(nextPending.scheduledAt).toISOString()
    : null;

  return {
    id: s.id,
    status: s.status,
    totalSbtcAmount: s.totalSbtcAmount,
    chunkSizeSats: s.chunkSizeSats,
    progress: `${s.completedChunks}/${s.totalChunks} chunks completed`,
    completedChunks: s.completedChunks,
    pendingChunks,
    failedChunks: s.failedChunks,
    nextExecution,
    createdAt: new Date(s.createdAt).toISOString(),
  };
}

program
  .command("direct-dca-status")
  .description(
    "Check your DCA schedule status. Shows all active DCA schedules (up to 10) " +
      "with chunk progress and next execution time."
  )
  .action(async () => {
    try {
      const { session } = await requireActiveKey();
      const api = getPillarApi();

      const raw = await api.get<{
        success: boolean;
        data: DcaStatusResult | null;
      }>("/api/pillar/dca-status", { walletAddress: session.smartWallet });

      const result = raw.data;

      if (!result) {
        printJson({
          success: true,
          hasSchedule: false,
          activeCount: 0,
          maxSchedules: 10,
          message:
            "No active DCA schedule. Use 'direct-boost' with an amount over 100,000 sats to start one.",
        });
        return;
      }

      const allSchedules = result.allSchedules || [
        { schedule: result.schedule, chunks: result.chunks },
      ];
      const activeCount =
        result.activeCount ?? (result.schedule.status === "active" ? 1 : 0);
      const maxSchedules = result.maxSchedules ?? 10;

      const schedules = allSchedules.map((entry) =>
        formatDcaSchedule(entry.schedule, entry.chunks)
      );

      const activeSchedules = schedules.filter((s) => s.status === "active");

      if (activeSchedules.length === 0) {
        const latest = schedules[0];
        printJson({
          success: true,
          hasSchedule: true,
          activeCount: 0,
          maxSchedules,
          schedule: latest,
          message: `DCA ${latest.status}: ${latest.progress}.`,
        });
        return;
      }

      if (activeSchedules.length === 1) {
        const s = activeSchedules[0];
        printJson({
          success: true,
          hasSchedule: true,
          activeCount,
          maxSchedules,
          schedule: s,
          message: `DCA active: ${s.progress} (${s.chunkSizeSats} sats/chunk). Next: ${s.nextExecution || "pending"}.`,
        });
        return;
      }

      const summaries = activeSchedules.map(
        (s) =>
          `Schedule ${s.id.slice(0, 8)}: ${s.progress}, next: ${s.nextExecution || "pending"}`
      );
      printJson({
        success: true,
        hasSchedule: true,
        activeCount,
        maxSchedules,
        schedules: activeSchedules,
        message: `${activeCount} active DCA schedules (max ${maxSchedules}):\n${summaries.join("\n")}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ===========================================================================
// Utility Operations
// ===========================================================================

// ---------------------------------------------------------------------------
// direct-quote
// ---------------------------------------------------------------------------

program
  .command("direct-quote")
  .description(
    "Get a boost quote (leverage, LTV, swap details) before executing. " +
      "No signing needed. Use this to determine aeUsdcToBorrow and minSbtcFromSwap."
  )
  .requiredOption("--sbtc-amount <sats>", "sBTC amount in sats to boost")
  .action(async (opts: { sbtcAmount: string }) => {
    try {
      const sbtcAmount = parseInt(opts.sbtcAmount, 10);

      const api = getPillarApi();
      const result = await api.get<{
        success: boolean;
        data: {
          sbtcAmount: number;
          aeUsdcToBorrow: number;
          minSbtcFromSwap: number;
          totalCollateralSats: number;
          effectiveLtv: number;
          leverageMultiplier: number;
          btcPriceUsd: number;
        };
      }>("/api/pillar/quote", { sbtcAmount });

      printJson({
        success: true,
        quote: result.data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-resolve-recipient
// ---------------------------------------------------------------------------

program
  .command("direct-resolve-recipient")
  .description(
    "Resolve a recipient before sending. Resolves BNS names (.btc), " +
      "Pillar wallet names, or validates a Stacks address."
  )
  .requiredOption(
    "--to <recipient>",
    "Recipient: BNS name (muneeb.btc), Pillar wallet name, or Stacks address (SP...)"
  )
  .option(
    "--recipient-type <type>",
    "Type of recipient: bns (default), wallet, or address",
    "bns"
  )
  .action(async (opts: { to: string; recipientType: string }) => {
    try {
      const api = getPillarApi();

      try {
        const resolvedAddress = await resolveRecipientAddress(
          api,
          opts.to,
          opts.recipientType
        );

        const effectiveType =
          opts.recipientType === "address" ||
          opts.to.startsWith("SP") ||
          opts.to.startsWith("ST")
            ? "address"
            : opts.recipientType;
        const bnsName =
          effectiveType === "bns"
            ? opts.to.endsWith(".btc")
              ? opts.to
              : `${opts.to}.btc`
            : undefined;

        printJson({
          success: true,
          input: opts.to,
          resolvedAddress,
          ...(bnsName ? { bnsName } : {}),
          type: effectiveType,
        });
      } catch (resolveError) {
        if (resolveError instanceof Error) {
          printJson({
            success: false,
            input: opts.to,
            error: resolveError.message,
          });
        } else {
          throw resolveError;
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

// ===========================================================================
// Stacking Operations
// ===========================================================================

// ---------------------------------------------------------------------------
// direct-stack-stx
// ---------------------------------------------------------------------------

program
  .command("direct-stack-stx")
  .description(
    "Stack STX from your Pillar smart wallet via Fast Pool or Stacking DAO. " +
      "Agent-signed, no browser needed. Backend sponsors gas."
  )
  .requiredOption(
    "--stx-amount <microStx>",
    "Amount of STX in micro-STX (1 STX = 1,000,000)"
  )
  .requiredOption(
    "--pool <pool>",
    "Stacking pool: fast-pool (delegates to pox4-fast-pool-v3) or stacking-dao (deposits for stSTX)"
  )
  .action(async (opts: { stxAmount: string; pool: string }) => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const validPools = ["fast-pool", "stacking-dao"];
      if (!validPools.includes(opts.pool)) {
        throw new Error(`--pool must be one of: ${validPools.join(", ")}`);
      }

      const stxAmount = parseInt(opts.stxAmount, 10);

      const { keyService, session } = await requireActiveKey();
      const authId = generateAuthId();

      const structuredData =
        opts.pool === "fast-pool"
          ? tupleCV({
              topic: stringAsciiCV("stack-stx-fast-pool"),
              "auth-id": uintCV(authId),
              "amount-ustx": uintCV(stxAmount),
            })
          : tupleCV({
              topic: stringAsciiCV("stake-stx-stacking-dao"),
              "auth-id": uintCV(authId),
              "stx-amount": uintCV(stxAmount),
            });

      const sigAuth = keyService.sign(structuredData, authId);
      const api = getPillarApi();
      const result = await api.post<{
        success: boolean;
        data: { txId: string; walletAddress: string; stxAmount: number; pool: string };
      }>("/api/pillar/stack-stx", {
        walletAddress: session.smartWallet,
        stxAmount,
        pool: opts.pool,
        sigAuth: formatSigAuthForApi(sigAuth),
      });

      const stxFormatted = formatStx(BigInt(stxAmount));
      const poolLabel = opts.pool === "fast-pool" ? "Fast Pool" : "Stacking DAO";

      printJson({
        success: true,
        operation:
          opts.pool === "fast-pool"
            ? "stack-stx-fast-pool"
            : "stake-stx-stacking-dao",
        txId: result.data.txId,
        explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
        walletAddress: session.smartWallet,
        stxAmount,
        stxFormatted,
        pool: poolLabel,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-revoke-fast-pool
// ---------------------------------------------------------------------------

program
  .command("direct-revoke-fast-pool")
  .description(
    "Revoke Fast Pool STX delegation from your Pillar smart wallet. " +
      "Agent-signed, no browser needed. STX stays locked until current PoX cycle ends."
  )
  .action(async () => {
    try {
      const guard = requireMainnetCheck();
      if (guard) {
        printJson(guard);
        return;
      }

      const { keyService, session } = await requireActiveKey();
      const authId = generateAuthId();

      const structuredData = tupleCV({
        topic: stringAsciiCV("revoke-fast-pool"),
        "auth-id": uintCV(authId),
      });

      const sigAuth = keyService.sign(structuredData, authId);
      const api = getPillarApi();
      const result = await api.post<{
        success: boolean;
        data: { txId: string };
      }>("/api/pillar/revoke-fast-pool", {
        walletAddress: session.smartWallet,
        sigAuth: formatSigAuthForApi(sigAuth),
      });

      printJson({
        success: true,
        operation: "revoke-fast-pool",
        txId: result.data.txId,
        explorerUrl: getExplorerTxUrl(result.data.txId, NETWORK),
        walletAddress: session.smartWallet,
        note: "Delegation revoked. STX will unlock after the current PoX cycle ends.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// direct-stacking-status
// ---------------------------------------------------------------------------

program
  .command("direct-stacking-status")
  .description(
    "Check stacking status for your Pillar smart wallet. " +
      "No signing needed — reads on-chain data."
  )
  .action(async () => {
    try {
      const { session } = await requireActiveKey();
      const hiro = getHiroApi(NETWORK);

      // Fetch STX balance (includes locked amount from stacking)
      const stxBalance = await hiro.getStxBalance(session.smartWallet);

      const balanceMicro = BigInt((stxBalance as { balance?: string }).balance || "0");
      const lockedMicro = BigInt((stxBalance as { locked?: string }).locked || "0");
      const liquidMicro = balanceMicro - lockedMicro;

      // Fetch PoX cycle info
      let poxInfo: {
        currentCycleId: number;
        nextCycleId: number;
        blocksUntilNextCycle: number;
        minAmountUstx: number;
        isPoxActive: boolean;
      } | null = null;

      try {
        const pox = await hiro.getPoxInfo();
        const poxData = pox as {
          current_cycle: { id: number; is_pox_active: boolean };
          next_cycle: { id: number; blocks_until_reward_phase: number };
          min_amount_ustx: number;
        };
        poxInfo = {
          currentCycleId: poxData.current_cycle.id,
          nextCycleId: poxData.next_cycle.id,
          blocksUntilNextCycle: poxData.next_cycle.blocks_until_reward_phase,
          minAmountUstx: poxData.min_amount_ustx,
          isPoxActive: poxData.current_cycle.is_pox_active,
        };
      } catch {
        // PoX info fetch failed
      }

      // Check enrollment status via backend
      const api = getPillarApi();
      const walletName = getWalletName(session.smartWallet);

      let enrollmentStatus: {
        enrolled: boolean;
        dualStackingTxId: string | null;
      } = { enrolled: false, dualStackingTxId: null };

      try {
        const walletInfo = await api.get<{
          success: boolean;
          data: {
            status: string;
            dualStackingTxId?: string | null;
          } | null;
        }>(`/api/smart-wallet/${walletName}`);

        if (walletInfo.data) {
          enrollmentStatus = {
            enrolled: !!walletInfo.data.dualStackingTxId,
            dualStackingTxId: walletInfo.data.dualStackingTxId || null,
          };
        }
      } catch {
        // Enrollment status fetch failed
      }

      const isStacking = lockedMicro > BigInt(0);

      printJson({
        success: true,
        walletAddress: session.smartWallet,
        stxBalance: {
          total: formatStx(balanceMicro),
          totalMicroStx: (stxBalance as { balance?: string }).balance,
          locked: formatStx(lockedMicro),
          lockedMicroStx: (stxBalance as { locked?: string }).locked,
          liquid: formatStx(liquidMicro),
          lockHeight: (stxBalance as { lock_height?: number }).lock_height || 0,
          burnchainUnlockHeight:
            (stxBalance as { burnchain_unlock_height?: number }).burnchain_unlock_height || 0,
        },
        isStacking,
        enrollment: enrollmentStatus,
        poxCycle: poxInfo,
        message: isStacking
          ? `Stacking ${formatStx(lockedMicro)} (${formatStx(liquidMicro)} liquid). ` +
            `${enrollmentStatus.enrolled ? "Dual stacking enrolled." : "Not enrolled in dual stacking."}`
          : `Not currently stacking. ${formatStx(balanceMicro)} STX available. ` +
            `${enrollmentStatus.enrolled ? "Dual stacking enrolled." : "Not enrolled in dual stacking."}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
