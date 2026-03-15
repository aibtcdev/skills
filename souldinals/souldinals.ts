#!/usr/bin/env bun
/**
 * Souldinals skill CLI
 * Inscribe soul.md as a child inscription, list/load soul inscriptions, display soul traits
 *
 * Usage: bun run souldinals/souldinals.ts <subcommand> [options]
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { MempoolApi, getMempoolTxUrl } from "../src/lib/services/mempool-api.js";
import {
  buildCommitTransaction,
  buildRevealTransaction,
  type InscriptionData,
} from "../src/lib/transactions/inscription-builder.js";
import { signBtcTransaction } from "../src/lib/transactions/bitcoin-builder.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOUL_CONTENT_TYPE = "text/markdown";
const UNISAT_API_BASE = "https://open-api.unisat.io";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve fee rate string or number to an actual sat/vB number.
 */
async function resolveFeeRate(
  feeRateInput: string | undefined,
  api: MempoolApi
): Promise<number> {
  const named = ["fast", "medium", "slow", undefined];
  if (named.includes(feeRateInput)) {
    const fees = await api.getFeeEstimates();
    if (!feeRateInput || feeRateInput === "medium") return fees.halfHourFee;
    if (feeRateInput === "fast") return fees.fastestFee;
    return fees.hourFee;
  }

  const numeric = parseFloat(feeRateInput!);
  if (isNaN(numeric) || numeric <= 0) {
    throw new Error(
      "--fee-rate must be 'fast', 'medium', 'slow', or a positive number (sat/vB)"
    );
  }
  return numeric;
}

/**
 * Build Unisat API request headers (includes API key if set).
 */
function unisatHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.UNISAT_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.UNISAT_API_KEY}`;
  }
  return headers;
}

/**
 * Fetch inscriptions for a Taproot address from Unisat Ordinals API.
 * Filters locally by mime_type=text/markdown.
 */
async function fetchSoulInscriptions(address: string): Promise<HiroInscription[]> {
  const url = `${UNISAT_API_BASE}/v1/indexer/address/${address}/inscription-data?cursor=0&size=60`;
  const response = await fetch(url, { headers: unisatHeaders() });

  if (!response.ok) {
    throw new Error(
      `Unisat API error ${response.status}: ${await response.text()}`
    );
  }

  const data = (await response.json()) as { code: number; data: { inscription: Array<{ inscriptionId: string; inscriptionNumber: number; contentType: string; contentLength: number; timestamp: number; genesisBlockHeight: number }> } };
  const items = data.data?.inscription ?? [];
  return items
    .filter((item) => item.contentType === SOUL_CONTENT_TYPE)
    .map((item) => ({
      id: item.inscriptionId,
      number: item.inscriptionNumber,
      content_type: item.contentType,
      content_length: item.contentLength,
      timestamp: new Date(item.timestamp * 1000).toISOString(),
      genesis_block_height: item.genesisBlockHeight,
    }));
}

/**
 * Fetch the raw content of an inscription from Unisat Ordinals API.
 */
async function fetchInscriptionContent(inscriptionId: string): Promise<string> {
  const url = `${UNISAT_API_BASE}/v1/indexer/inscription/content/${encodeURIComponent(inscriptionId)}`;
  const response = await fetch(url, { headers: unisatHeaders() });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch inscription content (${response.status}): ${await response.text()}`
    );
  }

  return await response.text();
}

/**
 * Fetch inscription metadata from Unisat Ordinals API.
 */
async function fetchInscriptionMetadata(inscriptionId: string): Promise<HiroInscription> {
  const url = `${UNISAT_API_BASE}/v1/indexer/inscription/info/${encodeURIComponent(inscriptionId)}`;
  const response = await fetch(url, { headers: unisatHeaders() });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch inscription metadata (${response.status}): ${await response.text()}`
    );
  }

  const data = (await response.json()) as { code: number; data: { inscriptionId: string; inscriptionNumber: number; contentType: string; contentLength: number; timestamp: number; genesisBlockHeight: number } };
  const item = data.data;
  return {
    id: item.inscriptionId,
    number: item.inscriptionNumber,
    content_type: item.contentType,
    content_length: item.contentLength,
    timestamp: new Date(item.timestamp * 1000).toISOString(),
    genesis_block_height: item.genesisBlockHeight,
  };
}

/**
 * Parse soul traits from Markdown content.
 * Extracts name (first H1), description (first paragraph after H1),
 * values (list items under "Values" or "Core Values" heading),
 * focus areas (list items under "Focus" or "Focus Areas" heading),
 * and all named sections.
 */
function parseSoulTraits(markdown: string): SoulTraits {
  const lines = markdown.split("\n");

  let name: string | undefined;
  let description: string | undefined;
  const sections: Record<string, string> = {};
  const values: string[] = [];
  const focusAreas: string[] = [];

  let currentSection: string | null = null;
  let sectionLines: string[] = [];
  let afterFirstH1 = false;
  let descriptionLines: string[] = [];
  let inDescriptionBlock = false;

  for (const line of lines) {
    // H1 heading — treat as name
    if (line.startsWith("# ")) {
      if (currentSection !== null) {
        sections[currentSection] = sectionLines.join("\n").trim();
        sectionLines = [];
      }
      if (!name) {
        name = line.replace(/^# /, "").trim();
        afterFirstH1 = true;
        inDescriptionBlock = true;
      } else {
        currentSection = line.replace(/^# /, "").trim();
      }
      continue;
    }

    // H2/H3 headings — section boundaries
    if (line.startsWith("## ") || line.startsWith("### ")) {
      if (currentSection !== null) {
        sections[currentSection] = sectionLines.join("\n").trim();
      }
      currentSection = line.replace(/^#{2,3} /, "").trim();
      sectionLines = [];
      inDescriptionBlock = false;
      continue;
    }

    // Capture description (non-empty lines immediately after H1, before any heading)
    if (afterFirstH1 && inDescriptionBlock && line.trim()) {
      descriptionLines.push(line.trim());
    } else if (afterFirstH1 && inDescriptionBlock && !line.trim() && descriptionLines.length > 0) {
      // Blank line ends description block
      inDescriptionBlock = false;
    }

    // Accumulate section content
    if (currentSection !== null) {
      sectionLines.push(line);

      // Parse list items for values and focus areas
      const listMatch = line.match(/^[-*]\s+(.+)/);
      if (listMatch) {
        const item = listMatch[1].trim();
        const sectionLower = currentSection.toLowerCase();
        if (sectionLower.includes("value")) {
          values.push(item);
        } else if (sectionLower.includes("focus")) {
          focusAreas.push(item);
        }
      }
    }
  }

  // Flush last section
  if (currentSection !== null) {
    sections[currentSection] = sectionLines.join("\n").trim();
  }

  if (descriptionLines.length > 0) {
    description = descriptionLines.join(" ");
  }

  return { name, description, values, focusAreas, sections };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HiroInscription {
  id: string;
  number: number;
  content_type: string;
  content_length: number;
  timestamp: string;
  genesis_block_height: number;
}

interface HiroInscriptionsResponse {
  results: HiroInscription[];
  total: number;
  limit: number;
  offset: number;
}

interface SoulTraits {
  name?: string;
  description?: string;
  values: string[];
  focusAreas: string[];
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("souldinals")
  .description(
    "Souldinals collection management: inscribe soul.md as a child inscription, " +
      "list and load soul inscriptions from wallet, display soul traits."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// inscribe-soul (Step 1: commit)
// ---------------------------------------------------------------------------

program
  .command("inscribe-soul")
  .description(
    "Inscribe a soul.md file as a child inscription — STEP 1: Broadcast commit transaction.\n\n" +
      "Reads the soul.md file, base64-encodes it, and broadcasts the commit transaction.\n" +
      "After the commit confirms (typically 10-60 min), use 'reveal-soul' to complete the inscription.\n\n" +
      "Returns: commitTxid, revealAmount, contentBase64 (save for reveal-soul)."
  )
  .requiredOption(
    "--parent-inscription-id <id>",
    "Genesis parent inscription ID (format: {txid}i{index})"
  )
  .option(
    "--soul-file <path>",
    "Path to the soul.md file",
    "./SOUL.md"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast | medium | slow | number in sat/vB (default: medium)"
  )
  .action(
    async (opts: {
      parentInscriptionId: string;
      soulFile: string;
      feeRate?: string;
    }) => {
      try {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();

        if (!sessionInfo) {
          throw new Error(
            "Wallet not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (!sessionInfo.btcAddress || !sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet doesn't have Bitcoin addresses. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (!account || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Wallet may not be unlocked."
          );
        }

        // Read soul.md file
        const soulFilePath = resolve(opts.soulFile);
        if (!existsSync(soulFilePath)) {
          throw new Error(`Soul file not found: ${soulFilePath}`);
        }

        const soulContent = readFileSync(soulFilePath, "utf-8");
        if (!soulContent.trim()) {
          throw new Error("Soul file is empty");
        }

        // Base64 encode the content
        const body = Buffer.from(soulContent, "utf-8");
        const contentBase64 = body.toString("base64");

        const inscription: InscriptionData = {
          contentType: SOUL_CONTENT_TYPE,
          body,
        };

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const utxos = await mempoolApi.getUtxos(sessionInfo.btcAddress);
        if (utxos.length === 0) {
          throw new Error(
            `No UTXOs available for address ${sessionInfo.btcAddress}. Send some BTC first.`
          );
        }

        const commitResult = buildCommitTransaction({
          utxos,
          inscription,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderAddress: sessionInfo.btcAddress,
          network: NETWORK,
          parentInscriptionId: opts.parentInscriptionId,
        });

        const commitSigned = signBtcTransaction(
          commitResult.tx,
          account.btcPrivateKey
        );
        const commitTxid = await mempoolApi.broadcastTransaction(
          commitSigned.txHex
        );
        const commitExplorerUrl = getMempoolTxUrl(commitTxid, NETWORK);

        printJson({
          status: "commit_broadcast",
          message:
            "Soul commit transaction broadcast successfully. " +
            "Wait for confirmation (typically 10-60 min), then call reveal-soul to complete.",
          commitTxid,
          commitExplorerUrl,
          revealAddress: commitResult.revealAddress,
          revealAmount: commitResult.revealAmount,
          commitFee: commitResult.fee,
          feeRate: actualFeeRate,
          parentInscriptionId: opts.parentInscriptionId,
          soulFile: opts.soulFile,
          contentType: SOUL_CONTENT_TYPE,
          contentSize: body.length,
          contentBase64,
          nextStep:
            `After commit confirms, call: bun run souldinals/souldinals.ts reveal-soul ` +
            `--commit-txid ${commitTxid} --reveal-amount ${commitResult.revealAmount} ` +
            `--content-base64 <contentBase64>`,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// reveal-soul (Step 2: reveal)
// ---------------------------------------------------------------------------

program
  .command("reveal-soul")
  .description(
    "Complete a soul inscription — STEP 2: Broadcast reveal transaction.\n\n" +
      "Call this AFTER the commit transaction from 'inscribe-soul' has confirmed.\n" +
      "Provide the commitTxid, revealAmount, and contentBase64 from the inscribe-soul response.\n\n" +
      "Returns: inscriptionId ({revealTxid}i0) on success."
  )
  .requiredOption(
    "--commit-txid <txid>",
    "Transaction ID of the confirmed commit transaction (64 hex chars)"
  )
  .requiredOption(
    "--reveal-amount <satoshis>",
    "Amount in the commit output in satoshis (from inscribe-soul response)"
  )
  .requiredOption(
    "--content-base64 <base64>",
    "Base64-encoded soul.md content (from inscribe-soul response)"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate for reveal tx: fast | medium | slow | number in sat/vB (default: medium)"
  )
  .action(
    async (opts: {
      commitTxid: string;
      revealAmount: string;
      contentBase64: string;
      feeRate?: string;
    }) => {
      try {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();

        if (!sessionInfo) {
          throw new Error(
            "Wallet not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (!sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet doesn't have a Taproot address. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (!account || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Wallet may not be unlocked."
          );
        }

        const revealAmountSats = parseInt(opts.revealAmount, 10);
        if (isNaN(revealAmountSats) || revealAmountSats <= 0) {
          throw new Error(
            "--reveal-amount must be a positive integer (satoshis)"
          );
        }

        if (opts.commitTxid.length !== 64) {
          throw new Error("--commit-txid must be exactly 64 hex characters");
        }

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const body = Buffer.from(opts.contentBase64, "base64");
        const inscription: InscriptionData = {
          contentType: SOUL_CONTENT_TYPE,
          body,
        };

        // Rebuild commit to recover the reveal script (deterministic)
        const dummyUtxos = [
          {
            txid: opts.commitTxid,
            vout: 0,
            value: revealAmountSats,
            status: {
              confirmed: true,
              block_height: 0,
              block_hash: "",
              block_time: 0,
            },
          },
        ];

        const commitResult = buildCommitTransaction({
          utxos: dummyUtxos,
          inscription,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderAddress: sessionInfo.btcAddress || "",
          network: NETWORK,
        });

        const revealResult = buildRevealTransaction({
          commitTxid: opts.commitTxid,
          commitVout: 0,
          commitAmount: revealAmountSats,
          revealScript: commitResult.revealScript,
          recipientAddress: sessionInfo.taprootAddress,
          feeRate: actualFeeRate,
          network: NETWORK,
        });

        const revealSigned = signBtcTransaction(
          revealResult.tx,
          account.btcPrivateKey
        );
        const revealTxid = await mempoolApi.broadcastTransaction(
          revealSigned.txHex
        );

        const inscriptionId = `${revealTxid}i0`;
        const revealExplorerUrl = getMempoolTxUrl(revealTxid, NETWORK);
        const commitExplorerUrl = getMempoolTxUrl(opts.commitTxid, NETWORK);

        printJson({
          status: "success",
          message: "Soul inscription created successfully!",
          inscriptionId,
          contentType: SOUL_CONTENT_TYPE,
          contentSize: body.length,
          commit: {
            txid: opts.commitTxid,
            explorerUrl: commitExplorerUrl,
          },
          reveal: {
            txid: revealTxid,
            fee: revealResult.fee,
            explorerUrl: revealExplorerUrl,
          },
          recipientAddress: sessionInfo.taprootAddress,
          note: "Soul inscription will appear at the recipient address once the reveal transaction confirms.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// list-souls
// ---------------------------------------------------------------------------

program
  .command("list-souls")
  .description(
    "List all soul inscriptions (text/markdown) owned by the wallet's Taproot address. " +
      "Queries the Unisat Ordinals API. Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const walletManager = getWalletManager();
      const sessionInfo = walletManager.getSessionInfo();

      if (!sessionInfo?.taprootAddress) {
        throw new Error(
          "Wallet not unlocked or doesn't have a Taproot address. " +
            "Use wallet/wallet.ts unlock first."
        );
      }

      const inscriptions = await fetchSoulInscriptions(
        sessionInfo.taprootAddress
      );

      const souls = inscriptions.map((ins) => ({
        id: ins.id,
        number: ins.number,
        contentType: ins.content_type,
        contentLength: ins.content_length,
        timestamp: ins.timestamp,
        genesisBlockHeight: ins.genesis_block_height,
      }));

      printJson({
        address: sessionInfo.taprootAddress,
        count: souls.length,
        souls,
        message:
          souls.length === 0
            ? "No soul inscriptions found. Use inscribe-soul to create one."
            : `Found ${souls.length} soul inscription(s).`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// load-soul
// ---------------------------------------------------------------------------

program
  .command("load-soul")
  .description(
    "Load and display the full content of the oldest soul inscription from the wallet. " +
      "Fetches content via the Unisat Ordinals API. Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const walletManager = getWalletManager();
      const sessionInfo = walletManager.getSessionInfo();

      if (!sessionInfo?.taprootAddress) {
        throw new Error(
          "Wallet not unlocked or doesn't have a Taproot address. " +
            "Use wallet/wallet.ts unlock first."
        );
      }

      const inscriptions = await fetchSoulInscriptions(
        sessionInfo.taprootAddress
      );

      if (inscriptions.length === 0) {
        printJson({
          address: sessionInfo.taprootAddress,
          found: false,
          message:
            "No soul inscriptions found. Use inscribe-soul to create one.",
        });
        return;
      }

      // Oldest is first (sorted by genesis_block_height asc)
      const oldest = inscriptions[0];
      const content = await fetchInscriptionContent(oldest.id);

      printJson({
        inscriptionId: oldest.id,
        contentType: oldest.content_type,
        contentSize: oldest.content_length,
        timestamp: oldest.timestamp,
        genesisBlockHeight: oldest.genesis_block_height,
        content,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// display-soul
// ---------------------------------------------------------------------------

program
  .command("display-soul")
  .description(
    "Parse and display soul traits from a specific inscription. " +
      "Fetches inscription content and extracts name, description, values, focus areas, and sections."
  )
  .requiredOption(
    "--inscription-id <id>",
    "Inscription ID (format: {txid}i{index})"
  )
  .action(async (opts: { inscriptionId: string }) => {
    try {
      // Fetch metadata and content in parallel
      const [metadata, content] = await Promise.all([
        fetchInscriptionMetadata(opts.inscriptionId),
        fetchInscriptionContent(opts.inscriptionId),
      ]);

      const traits = parseSoulTraits(content);

      printJson({
        inscriptionId: opts.inscriptionId,
        contentType: metadata.content_type,
        contentLength: metadata.content_length,
        timestamp: metadata.timestamp,
        genesisBlockHeight: metadata.genesis_block_height,
        traits,
        rawContent: content,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
