import { redactSensitive } from "./redact.js";

/**
 * Base error class for aibtc skills
 */
export class AibtcError extends Error {
  public readonly suggestion: string;
  public readonly docsRef?: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
    suggestion?: string,
    docsRef?: string
  ) {
    super(message);
    this.name = "AibtcError";
    this.suggestion =
      suggestion ??
      "File an issue at github.com/aibtcdev/skills/issues if this persists";
    this.docsRef = docsRef;
  }
}

/**
 * Error for invalid configuration
 */
export class ConfigError extends AibtcError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFIG_ERROR", details);
    this.name = "ConfigError";
  }
}

/**
 * Error for transaction failures
 */
export class TransactionError extends AibtcError {
  constructor(message: string, public readonly txid?: string, details?: unknown) {
    super(message, "TRANSACTION_ERROR", details);
    this.name = "TransactionError";
  }
}

/**
 * Error for API failures
 */
export class ApiError extends AibtcError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    details?: unknown
  ) {
    super(message, "API_ERROR", details);
    this.name = "ApiError";
  }
}

/**
 * Error for contract call failures
 */
export class ContractError extends AibtcError {
  constructor(
    message: string,
    public readonly contractId?: string,
    details?: unknown
  ) {
    super(message, "CONTRACT_ERROR", details);
    this.name = "ContractError";
  }
}

/**
 * Base error for wallet operations
 */
export class WalletError extends AibtcError {
  constructor(
    message: string,
    details?: unknown,
    suggestion?: string,
    docsRef?: string
  ) {
    super(message, "WALLET_ERROR", details, suggestion, docsRef);
    this.name = "WalletError";
  }
}

/**
 * Error when wallet is locked and operation requires unlocked wallet
 */
export class WalletLockedError extends WalletError {
  constructor() {
    super(
      "Wallet is locked. Run: bun run wallet/wallet.ts unlock --password <password>",
      undefined,
      "Run: bun run wallet/wallet.ts unlock --password <password>",
      "wallet/SKILL.md"
    );
    this.name = "WalletLockedError";
  }
}

/**
 * Error when wallet is not found
 */
export class WalletNotFoundError extends WalletError {
  constructor(walletId: string) {
    super(
      `Wallet not found: ${walletId}. Create one with: bun run wallet/wallet.ts create --name main --password <password>`,
      undefined,
      "Run: bun run wallet/wallet.ts create --name main --password <password> or import with: bun run wallet/wallet.ts import --name main --mnemonic <mnemonic> --password <password>",
      "wallet/SKILL.md"
    );
    this.name = "WalletNotFoundError";
  }
}

/**
 * Error for invalid password
 */
export class InvalidPasswordError extends WalletError {
  constructor() {
    super(
      "Invalid password. Check for typos and try again.",
      undefined,
      "Double-check your password. If forgotten, recover via mnemonic: bun run wallet/wallet.ts import --name <name> --mnemonic <mnemonic> --password <newpassword>",
      "wallet/SKILL.md"
    );
    this.name = "InvalidPasswordError";
  }
}

/**
 * Error for invalid mnemonic
 */
export class InvalidMnemonicError extends WalletError {
  constructor() {
    super(
      "Invalid mnemonic phrase",
      undefined,
      "Ensure the mnemonic is a valid BIP39 phrase (12 or 24 words). Check for typos or extra spaces.",
      "wallet/SKILL.md"
    );
    this.name = "InvalidMnemonicError";
  }
}

/**
 * Error when account has insufficient balance for an operation
 */
export class InsufficientBalanceError extends AibtcError {
  constructor(
    message: string,
    public readonly tokenType: 'STX' | 'sBTC',
    public readonly balance: string,
    public readonly required: string,
    public readonly shortfall: string
  ) {
    const suggestion =
      tokenType === 'STX'
        ? "Fund your wallet with STX. Testnet faucet: https://explorer.hiro.so/sandbox/faucet?chain=testnet. " +
          "Mainnet: purchase STX on an exchange and send to your Stacks address."
        : "Deposit BTC to receive sBTC. Run: bun run sbtc/sbtc.ts deposit --amount <satoshis> " +
          "or see the deposit workflow guide.";
    super(
      message,
      "INSUFFICIENT_BALANCE",
      { tokenType, balance, required, shortfall },
      suggestion,
      "what-to-do/check-balances.md"
    );
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Format error for skill output
 */
export function formatError(error: unknown): {
  message: string;
  code?: string;
  details?: unknown;
  suggestion?: string;
  docsRef?: string;
} {
  if (error instanceof AibtcError) {
    return {
      message: redactSensitive(error.message),
      code: error.code,
      details: error.details,
      suggestion: error.suggestion,
      docsRef: error.docsRef,
    };
  }

  if (error instanceof Error) {
    return { message: redactSensitive(error.message) };
  }

  return { message: "Unknown error occurred" };
}
