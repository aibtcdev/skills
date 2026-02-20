import fs from "fs/promises";
import path from "path";

export type PricingTier = "free" | "simple" | "standard" | "ai" | "heavy_ai" | "storage_read" | "storage_write";

export interface EndpointConfig {
  path: string;
  method: "GET" | "POST";
  description: string;
  /** Amount in human-readable form (e.g., "0.001") - used when tier is not specified */
  amount?: string;
  tokenType: "STX" | "sBTC" | "USDCx";
  /** Pricing tier - if specified, overrides amount with tier-based pricing */
  tier?: PricingTier;
}

export interface AIEndpointConfig {
  path: string;
  description: string;
  amount: string;
  tokenType: "STX" | "sBTC" | "USDCx";
  aiType: "chat" | "completion" | "summarize" | "translate" | "custom";
  model?: string;
  systemPrompt?: string;
}

export interface ScaffoldConfig {
  outputDir: string;
  projectName: string;
  endpoints: EndpointConfig[];
  /** Recipient address - if not provided, must be set via wrangler secret */
  recipientAddress?: string;
  network: "mainnet" | "testnet";
  relayUrl: string;
}

export interface ScaffoldResult {
  projectPath: string;
  filesCreated: string[];
  nextSteps: string[];
}

export interface AIScaffoldConfig {
  outputDir: string;
  projectName: string;
  endpoints: AIEndpointConfig[];
  /** Recipient address - if not provided, must be set via wrangler secret */
  recipientAddress?: string;
  network: "mainnet" | "testnet";
  relayUrl: string;
  defaultModel: string;
}

// Token decimals for conversion
const TOKEN_DECIMALS: Record<string, number> = {
  STX: 6,
  sBTC: 8,
  USDCx: 6,
};

// Pricing tier amounts (matches x402-api and stx402 patterns)
const TIER_AMOUNTS: Record<PricingTier, Record<"STX" | "sBTC" | "USDCx", string>> = {
  free: { STX: "0", sBTC: "0", USDCx: "0" },
  simple: { STX: "0.001", sBTC: "0.000001", USDCx: "0.001" },
  standard: { STX: "0.001", sBTC: "0.000001", USDCx: "0.001" },
  ai: { STX: "0.003", sBTC: "0.000003", USDCx: "0.003" },
  heavy_ai: { STX: "0.01", sBTC: "0.00001", USDCx: "0.01" },
  storage_read: { STX: "0.0005", sBTC: "0.0000005", USDCx: "0.0005" },
  storage_write: { STX: "0.001", sBTC: "0.000001", USDCx: "0.001" },
};

/**
 * Convert human-readable amount to smallest unit (microSTX, sats, etc.)
 */
function toSmallestUnit(amount: string, tokenType: "STX" | "sBTC" | "USDCx"): string {
  const decimals = TOKEN_DECIMALS[tokenType];
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction).toString();
}

/**
 * Get amount for endpoint based on tier or explicit amount
 */
function getEndpointAmount(ep: EndpointConfig): string {
  if (ep.tier) {
    return TIER_AMOUNTS[ep.tier][ep.tokenType];
  }
  return ep.amount || TIER_AMOUNTS.standard[ep.tokenType];
}

/**
 * Generate Hono route code for each endpoint
 */
function generateEndpointCode(endpoints: EndpointConfig[]): string {
  return endpoints
    .map((ep) => {
      const amount = getEndpointAmount(ep);
      const amountSmallest = toSmallestUnit(amount, ep.tokenType);
      const tierComment = ep.tier ? ` (tier: ${ep.tier})` : "";
      // Generate real example logic based on endpoint characteristics
      const exampleLogic = generateExampleLogic(ep);
      return `
// ${ep.description}${tierComment}
app.${ep.method.toLowerCase()}('${ep.path}',
  x402Middleware({
    amount: '${amountSmallest}',
    tokenType: '${ep.tokenType}',
  }),
  async (c) => {
    const payment = c.get('x402');
${exampleLogic}
  }
);`;
    })
    .join("\n");
}

/**
 * Generate real example logic for endpoints based on their configuration.
 * This replaces placeholder/TODO code with working examples.
 */
function generateExampleLogic(ep: EndpointConfig): string {
  if (ep.method === "POST") {
    return `
    // Parse request body
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));

    // Your business logic here - this example echoes the request
    const result = {
      received: body,
      processedAt: new Date().toISOString(),
    };

    return c.json({
      success: true,
      data: result,
      payment: {
        txId: payment?.settleResult?.txId,
        sender: payment?.payerAddress,
      },
    });`;
  }

  // GET endpoint - return example data
  return `
    // Your business logic here - this example returns sample data
    const data = {
      id: crypto.randomUUID(),
      description: '${ep.description}',
      generatedAt: new Date().toISOString(),
    };

    return c.json({
      success: true,
      data,
      payment: {
        txId: payment?.settleResult?.txId,
        sender: payment?.payerAddress,
      },
    });`;
}

/**
 * Generate endpoint documentation for README
 */
function generateEndpointDocs(endpoints: EndpointConfig[]): string {
  return endpoints
    .map((ep) => {
      const amount = getEndpointAmount(ep);
      const tierInfo = ep.tier ? ` (tier: ${ep.tier})` : "";
      return `### ${ep.method} ${ep.path}
- **Description:** ${ep.description}
- **Cost:** ${amount} ${ep.tokenType}${tierInfo}
- **Payment Required:** Yes`;
    })
    .join("\n\n");
}

/**
 * Generate token list for README
 */
function generateTokenList(endpoints: EndpointConfig[]): string {
  const tokens = [...new Set(endpoints.map((ep) => ep.tokenType))];
  return tokens.map((t) => `- ${t}`).join("\n");
}

// =============================================================================
// FILE TEMPLATES
// =============================================================================

function getIndexTemplate(endpoints: EndpointConfig[]): string {
  const endpointCode = generateEndpointCode(endpoints);
  return `// BigInt.toJSON polyfill for JSON.stringify compatibility
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402Middleware } from './x402-middleware';
import type { X402Context } from './x402-middleware';

type Env = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
};

type Variables = {
  x402?: X402Context;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS middleware with x402 headers
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['X-PAYMENT', 'X-PAYMENT-TOKEN-TYPE', 'Authorization', 'Content-Type'],
  exposeHeaders: ['X-PAYMENT-RESPONSE', 'X-PAYER-ADDRESS'],
}));

// Startup validation - fail fast if required secrets are missing
app.use('*', async (c, next) => {
  // Skip validation for health check
  if (c.req.path === '/health') {
    return next();
  }

  const missingSecrets: string[] = [];

  if (!c.env.RECIPIENT_ADDRESS) {
    missingSecrets.push('RECIPIENT_ADDRESS');
  }

  if (missingSecrets.length > 0) {
    return c.json({
      error: 'Server configuration error',
      message: \`Missing required secrets: \${missingSecrets.join(', ')}\`,
      hint: missingSecrets.map(s => \`Run: wrangler secret put \${s}\`).join(' && '),
    }, 503);
  }

  await next();
});

// Service info at root (free)
app.get('/', (c) => {
  return c.json({
    service: '${endpoints.length > 0 ? "x402-api" : "my-x402-api"}',
    version: '1.0.0',
    health: '/health',
    payment: {
      tokens: ['STX', 'sBTC', 'USDCx'],
      header: 'X-PAYMENT',
      tokenTypeHeader: 'X-PAYMENT-TOKEN-TYPE',
    },
  });
});

// Health check (free)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    network: c.env.NETWORK || 'testnet',
  });
});
${endpointCode}

export default app;
`;
}

function getMiddlewareTemplate(): string {
  return `/**
 * x402 Payment Middleware for Hono
 *
 * Based on production implementations from:
 * - https://github.com/aibtcdev/x402-api
 * - https://github.com/whoabuddy/stx402
 *
 * Uses the x402-relay service for payment verification.
 */

import type { Context, Next } from 'hono';

// =============================================================================
// Types
// =============================================================================

export type TokenType = 'STX' | 'sBTC' | 'USDCx';

export interface TokenContract {
  address: string;
  name: string;
}

export interface X402Config {
  amount: string;
  tokenType: TokenType;
}

export interface SettleResult {
  isValid: boolean;
  txId?: string;
  status?: string;
  sender?: string;
  senderAddress?: string;
  sender_address?: string;
  recipient?: string;
  error?: string;
  reason?: string;
  validationError?: string;
}

export interface X402Context {
  payerAddress: string;
  settleResult: SettleResult;
  signedTx: string;
}

interface PaymentRequirement {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: 'mainnet' | 'testnet';
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
  tokenContract?: TokenContract;
}

type PaymentErrorCode =
  | 'RELAY_UNAVAILABLE'
  | 'RELAY_ERROR'
  | 'PAYMENT_INVALID'
  | 'INSUFFICIENT_FUNDS'
  | 'PAYMENT_EXPIRED'
  | 'AMOUNT_TOO_LOW'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

interface PaymentErrorResponse {
  error: string;
  code: PaymentErrorCode;
  retryAfter?: number;
  tokenType: TokenType;
  resource: string;
  details?: Record<string, string | undefined>;
}

// =============================================================================
// Token Contracts (correct mainnet/testnet addresses)
// =============================================================================

const TOKEN_CONTRACTS: Record<'mainnet' | 'testnet', Record<'sBTC' | 'USDCx', TokenContract>> = {
  mainnet: {
    sBTC: { address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4', name: 'sbtc-token' },
    USDCx: { address: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE', name: 'usdcx' },
  },
  testnet: {
    sBTC: { address: 'ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT', name: 'sbtc-token' },
    USDCx: { address: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM', name: 'usdcx' },
  },
};

// =============================================================================
// Error Classification
// =============================================================================

function classifyPaymentError(error: unknown, settleResult?: SettleResult): {
  code: PaymentErrorCode;
  message: string;
  httpStatus: number;
  retryAfter?: number;
} {
  const errorStr = String(error).toLowerCase();
  const resultError = settleResult?.error?.toLowerCase() || '';
  const resultReason = settleResult?.reason?.toLowerCase() || '';
  const validationError = settleResult?.validationError?.toLowerCase() || '';
  const combined = \`\${errorStr} \${resultError} \${resultReason} \${validationError}\`;

  if (combined.includes('fetch') || combined.includes('network') || combined.includes('timeout')) {
    return { code: 'NETWORK_ERROR', message: 'Network error with payment relay', httpStatus: 502, retryAfter: 5 };
  }

  if (combined.includes('503') || combined.includes('unavailable')) {
    return { code: 'RELAY_UNAVAILABLE', message: 'Payment relay temporarily unavailable', httpStatus: 503, retryAfter: 30 };
  }

  if (combined.includes('insufficient') || combined.includes('balance')) {
    return { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in wallet', httpStatus: 402 };
  }

  if (combined.includes('expired') || combined.includes('nonce')) {
    return { code: 'PAYMENT_EXPIRED', message: 'Payment expired, please sign a new payment', httpStatus: 402 };
  }

  if (combined.includes('amount') && (combined.includes('low') || combined.includes('minimum'))) {
    return { code: 'AMOUNT_TOO_LOW', message: 'Payment amount below minimum required', httpStatus: 402 };
  }

  if (combined.includes('invalid') || combined.includes('signature')) {
    return { code: 'PAYMENT_INVALID', message: 'Invalid payment signature', httpStatus: 400 };
  }

  return { code: 'UNKNOWN_ERROR', message: 'Payment processing error', httpStatus: 500, retryAfter: 5 };
}

// =============================================================================
// Middleware
// =============================================================================

type Env = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
};

/**
 * x402 Payment Middleware
 *
 * Handles the x402 payment flow:
 * 1. If no X-PAYMENT header, return 402 with payment requirements
 * 2. If X-PAYMENT header present, verify payment via relay
 * 3. On success, attach payment context and continue to handler
 */
export function x402Middleware(config: X402Config) {
  return async (c: Context<{ Bindings: Env; Variables: { x402?: X402Context } }>, next: Next) => {
    const env = c.env;
    const network = (env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
    const relayUrl = env.RELAY_URL || (network === 'mainnet' ? 'https://x402-relay.aibtc.com' : 'https://x402-relay.aibtc.dev');
    const recipientAddress = env.RECIPIENT_ADDRESS;

    // Get token type from header or use config default
    const headerTokenType = c.req.header('X-PAYMENT-TOKEN-TYPE');
    const tokenType = (headerTokenType?.toUpperCase() === 'SBTC' ? 'sBTC' :
                       headerTokenType?.toUpperCase() === 'USDCX' ? 'USDCx' :
                       headerTokenType?.toUpperCase() === 'STX' ? 'STX' :
                       config.tokenType) as TokenType;

    const minAmount = BigInt(config.amount);
    const signedTx = c.req.header('X-PAYMENT');

    if (!signedTx) {
      // Return 402 Payment Required
      let tokenContract: TokenContract | undefined;
      if (tokenType === 'sBTC' || tokenType === 'USDCx') {
        tokenContract = TOKEN_CONTRACTS[network][tokenType];
      }

      const paymentReq: PaymentRequirement = {
        maxAmountRequired: config.amount,
        resource: c.req.path,
        payTo: recipientAddress,
        network,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        tokenType,
        ...(tokenContract && { tokenContract }),
      };

      return c.json(paymentReq, 402);
    }

    // Verify payment via x402 relay
    let settleResult: SettleResult;
    try {
      const relayResponse = await fetch(\`\${relayUrl}/settle\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedTx,
          expectedRecipient: recipientAddress,
          minAmount: config.amount,
          tokenType,
          network,
        }),
      });

      if (!relayResponse.ok) {
        const errorText = await relayResponse.text().catch(() => relayResponse.statusText);
        throw new Error(\`Relay returned \${relayResponse.status}: \${errorText}\`);
      }

      settleResult = (await relayResponse.json()) as SettleResult;
    } catch (error) {
      const classified = classifyPaymentError(error);

      const errorResponse: PaymentErrorResponse = {
        error: classified.message,
        code: classified.code,
        retryAfter: classified.retryAfter,
        tokenType,
        resource: c.req.path,
        details: { exceptionMessage: String(error) },
      };

      if (classified.retryAfter) {
        c.header('Retry-After', String(classified.retryAfter));
      }

      return c.json(errorResponse, classified.httpStatus as 400 | 402 | 500 | 502 | 503);
    }

    if (!settleResult.isValid) {
      const classified = classifyPaymentError(
        settleResult.validationError || settleResult.error || 'invalid',
        settleResult
      );

      const errorResponse: PaymentErrorResponse = {
        error: classified.message,
        code: classified.code,
        retryAfter: classified.retryAfter,
        tokenType,
        resource: c.req.path,
        details: {
          settleError: settleResult.error,
          settleReason: settleResult.reason,
          validationError: settleResult.validationError,
        },
      };

      if (classified.retryAfter) {
        c.header('Retry-After', String(classified.retryAfter));
      }

      return c.json(errorResponse, classified.httpStatus as 400 | 402 | 500 | 502 | 503);
    }

    // Extract payer address
    const payerAddress = settleResult.senderAddress || settleResult.sender_address || settleResult.sender || 'unknown';

    // Store context for downstream handlers
    c.set('x402', {
      payerAddress,
      settleResult,
      signedTx,
    });

    // Add response headers
    c.header('X-PAYMENT-RESPONSE', JSON.stringify(settleResult));
    c.header('X-PAYER-ADDRESS', payerAddress);

    await next();
  };
}
`;
}

function getWranglerTemplate(projectName: string, network: string, relayUrl: string): string {
  const mainnetRelay = "https://x402-relay.aibtc.com";
  const testnetRelay = "https://x402-relay.aibtc.dev";
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${projectName}",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-14",
  "compatibility_flags": ["nodejs_compat_v2"],
  "workers_dev": true,
  "vars": {
    "NETWORK": "${network}",
    "RELAY_URL": "${relayUrl}"
  },
  "env": {
    "staging": {
      "name": "${projectName}-staging",
      "workers_dev": true,
      "vars": {
        "NETWORK": "testnet",
        "RELAY_URL": "${testnetRelay}"
      }
    },
    "production": {
      "name": "${projectName}",
      "workers_dev": false,
      "vars": {
        "NETWORK": "mainnet",
        "RELAY_URL": "${mainnetRelay}"
      }
    }
  }
}
`;
}

function getPackageJsonTemplate(projectName: string): string {
  return `{
  "name": "${projectName}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "tail": "wrangler tail",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250109.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.56.0"
  }
}
`;
}

function getTsconfigTemplate(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
`;
}

function getEnvExampleTemplate(recipientAddress?: string): string {
  const addressNote = recipientAddress
    ? `# Value: ${recipientAddress}`
    : "# Value: Your Stacks address (SP... for mainnet, ST... for testnet)";
  return `# Cloudflare credentials (only needed for CI/CD deployment)
# For local dev, wrangler uses browser-based auth
CLOUDFLARE_API_TOKEN=your-api-token-here
CLOUDFLARE_ACCOUNT_ID=your-account-id-here

# x402 recipient address (set via wrangler secret)
# wrangler secret put RECIPIENT_ADDRESS
${addressNote}
`;
}

function getDevVarsTemplate(recipientAddress?: string): string {
  const address = recipientAddress || "YOUR_STACKS_ADDRESS_HERE";
  return `# Local development variables
# These are used by wrangler dev and are NOT deployed to production
# For production secrets, use: wrangler secret put RECIPIENT_ADDRESS

RECIPIENT_ADDRESS=${address}
`;
}

function getGitignoreTemplate(): string {
  return `node_modules/
dist/
.env
.dev.vars
.wrangler/
`;
}

function getReadmeTemplate(
  projectName: string,
  endpoints: EndpointConfig[],
  recipientAddress?: string
): string {
  const tokenList = generateTokenList(endpoints);
  const endpointDocs = generateEndpointDocs(endpoints);
  const addressDisplay = recipientAddress || "YOUR_STACKS_ADDRESS";

  return `# ${projectName}

x402-enabled API endpoints on Cloudflare Workers.

Built using patterns from:
- [x402-api](https://github.com/aibtcdev/x402-api)
- [stx402](https://github.com/whoabuddy/stx402)

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Set your recipient address for local dev
# Edit .dev.vars and replace YOUR_STACKS_ADDRESS_HERE with your address

# Start local dev server
npm run dev
\`\`\`

The server will start at http://localhost:8787

## Payment Tokens

This API accepts payments in:
${tokenList}

## Endpoints

### GET /
- **Description:** Service info
- **Cost:** Free

### GET /health
- **Description:** Health check endpoint
- **Cost:** Free

${endpointDocs}

## Deployment

### Set Production Secrets

\`\`\`bash
# Set your recipient address (where payments will be sent)
wrangler secret put RECIPIENT_ADDRESS
# Enter: ${addressDisplay}
\`\`\`

### Deploy

\`\`\`bash
# Deploy to staging (testnet)
npm run deploy:staging

# Deploy to production (mainnet)
npm run deploy:production
\`\`\`

## x402 Payment Flow

1. Client makes request without payment header
2. Server returns HTTP 402 with payment requirements:
   \`\`\`json
   {
     "maxAmountRequired": "1000",
     "resource": "/api/endpoint",
     "payTo": "${addressDisplay}",
     "network": "testnet",
     "tokenType": "STX",
     "nonce": "uuid",
     "expiresAt": "2024-01-01T00:05:00Z"
   }
   \`\`\`
3. Client signs payment transaction (does NOT broadcast)
4. Client retries request with \`X-PAYMENT\` header containing signed tx
5. Server verifies and settles payment via relay
6. Server returns actual response

## Testing with curl

\`\`\`bash
# Service info (free)
curl http://localhost:8787/

# Health check (free)
curl http://localhost:8787/health

# Protected endpoint (returns 402)
curl http://localhost:8787${endpoints[0]?.path || "/api/endpoint"}
\`\`\`

## Token Type Selection

Clients can specify which token to pay with using the \`X-PAYMENT-TOKEN-TYPE\` header:

\`\`\`bash
# Pay with sBTC instead of STX
curl -H "X-PAYMENT-TOKEN-TYPE: sBTC" http://localhost:8787${endpoints[0]?.path || "/api/endpoint"}
\`\`\`

Supported values: \`STX\`, \`sBTC\`, \`USDCx\`

## Error Codes

The API returns structured error responses for payment failures:

| Code | Description | HTTP Status |
|------|-------------|-------------|
| \`INSUFFICIENT_FUNDS\` | Wallet needs funding | 402 |
| \`PAYMENT_EXPIRED\` | Sign a new payment | 402 |
| \`AMOUNT_TOO_LOW\` | Payment below minimum | 402 |
| \`PAYMENT_INVALID\` | Bad signature/params | 400 |
| \`NETWORK_ERROR\` | Transient error | 502 |
| \`RELAY_UNAVAILABLE\` | Try again later | 503 |

---

Generated with [@aibtc/mcp-server](https://www.npmjs.com/package/@aibtc/mcp-server) scaffold tool.
`;
}

// =============================================================================
// SHARED SCAFFOLD HELPERS
// =============================================================================

/**
 * Validate that the output directory exists and is a directory.
 */
async function validateOutputDir(outputDir: string): Promise<void> {
  try {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      throw new Error(`Output path is not a directory: ${outputDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Output directory does not exist: ${outputDir}`);
    }
    throw error;
  }
}

/**
 * Create project directory structure and write all files.
 * Returns the list of file names created.
 */
async function writeProjectFiles(
  projectPath: string,
  files: Array<{ name: string; content: string }>
): Promise<string[]> {
  const srcPath = path.join(projectPath, "src");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(srcPath, { recursive: true });

  const filesCreated: string[] = [];
  for (const file of files) {
    const filePath = path.join(projectPath, file.name);
    await fs.writeFile(filePath, file.content, "utf-8");
    filesCreated.push(file.name);
  }
  return filesCreated;
}

/**
 * Build the wrangler secret instruction for RECIPIENT_ADDRESS.
 */
function getAddressInstruction(recipientAddress?: string): string {
  return recipientAddress
    ? `wrangler secret put RECIPIENT_ADDRESS (enter: ${recipientAddress})`
    : "wrangler secret put RECIPIENT_ADDRESS (enter your Stacks address)";
}

// =============================================================================
// MAIN SCAFFOLD FUNCTION
// =============================================================================

export async function scaffoldProject(config: ScaffoldConfig): Promise<ScaffoldResult> {
  const { outputDir, projectName, endpoints, recipientAddress, network, relayUrl } = config;

  await validateOutputDir(outputDir);

  const projectPath = path.join(outputDir, projectName);
  const filesCreated = await writeProjectFiles(projectPath, [
    { name: "src/index.ts", content: getIndexTemplate(endpoints) },
    { name: "src/x402-middleware.ts", content: getMiddlewareTemplate() },
    { name: "wrangler.jsonc", content: getWranglerTemplate(projectName, network, relayUrl) },
    { name: "package.json", content: getPackageJsonTemplate(projectName) },
    { name: "tsconfig.json", content: getTsconfigTemplate() },
    { name: ".env.example", content: getEnvExampleTemplate(recipientAddress) },
    { name: ".dev.vars", content: getDevVarsTemplate(recipientAddress) },
    { name: ".gitignore", content: getGitignoreTemplate() },
    { name: "README.md", content: getReadmeTemplate(projectName, endpoints, recipientAddress) },
  ]);

  return {
    projectPath,
    filesCreated,
    nextSteps: [
      `cd ${projectPath}`,
      "npm install",
      recipientAddress
        ? "# .dev.vars is pre-configured with your address"
        : "# Edit .dev.vars and set your RECIPIENT_ADDRESS",
      "npm run dev",
      "# For production deployment:",
      getAddressInstruction(recipientAddress),
      "npm run deploy:production",
    ],
  };
}

// =============================================================================
// AI ENDPOINT TEMPLATES (OpenRouter)
// =============================================================================

const AI_TYPE_CONFIGS: Record<string, { systemPrompt: string; description: string }> = {
  chat: {
    systemPrompt: "You are a helpful AI assistant.",
    description: "Chat with an AI assistant",
  },
  completion: {
    systemPrompt: "You are a creative writing assistant. Complete the given text naturally.",
    description: "AI text completion",
  },
  summarize: {
    systemPrompt:
      "You are a summarization expert. Provide concise summaries of the given text, capturing the key points.",
    description: "Summarize text using AI",
  },
  translate: {
    systemPrompt:
      "You are a professional translator. Translate the given text accurately while preserving meaning and tone.",
    description: "Translate text using AI",
  },
  custom: {
    systemPrompt: "You are a helpful AI assistant.",
    description: "Custom AI endpoint",
  },
};

function generateAIEndpointCode(endpoints: AIEndpointConfig[], defaultModel: string): string {
  return endpoints
    .map((ep) => {
      const amountSmallest = toSmallestUnit(ep.amount, ep.tokenType);
      const config = AI_TYPE_CONFIGS[ep.aiType];
      const systemPrompt = ep.systemPrompt || config.systemPrompt;
      const model = ep.model || defaultModel;

      return `
// ${ep.description}
app.post('${ep.path}',
  x402Middleware({
    amount: '${amountSmallest}',
    tokenType: '${ep.tokenType}',
  }),
  async (c) => {
    const payment = c.get('x402');
    const body = await c.req.json<{ prompt?: string; message?: string; text?: string; targetLanguage?: string }>();
    const userInput = body.prompt || body.message || body.text || '';

    if (!userInput) {
      return c.json({ error: 'Missing required field: prompt, message, or text' }, 400);
    }

    const result = await callOpenRouter({
      apiKey: c.env.OPENROUTER_API_KEY,
      model: '${model}',
      systemPrompt: \`${systemPrompt.replace(/`/g, "\\`")}\`,
      userMessage: ${ep.aiType === "translate" ? "`Translate to ${body.targetLanguage || 'English'}: ${userInput}`" : "userInput"},
    });

    return c.json({
      result: result.content,
      model: result.model,
      usage: result.usage,
      payment: {
        txId: payment?.settleResult?.txId,
        sender: payment?.payerAddress,
      },
    });
  }
);`;
    })
    .join("\n");
}

function generateAIEndpointDocs(endpoints: AIEndpointConfig[]): string {
  return endpoints
    .map((ep) => {
      const inputField =
        ep.aiType === "translate" ? "text, targetLanguage (optional)" : "prompt or message or text";
      return `### POST ${ep.path}
- **Description:** ${ep.description}
- **Cost:** ${ep.amount} ${ep.tokenType}
- **AI Type:** ${ep.aiType}
- **Input:** \`{ ${inputField} }\`
- **Payment Required:** Yes`;
    })
    .join("\n\n");
}

function getAIIndexTemplate(endpoints: AIEndpointConfig[], defaultModel: string): string {
  const endpointCode = generateAIEndpointCode(endpoints, defaultModel);
  return `// BigInt.toJSON polyfill for JSON.stringify compatibility
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402Middleware } from './x402-middleware';
import type { X402Context } from './x402-middleware';
import { callOpenRouter } from './openrouter';

type Env = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
  OPENROUTER_API_KEY: string;
};

type Variables = {
  x402?: X402Context;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS middleware with x402 headers
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['X-PAYMENT', 'X-PAYMENT-TOKEN-TYPE', 'Authorization', 'Content-Type'],
  exposeHeaders: ['X-PAYMENT-RESPONSE', 'X-PAYER-ADDRESS'],
}));

// Startup validation - fail fast if required secrets are missing
app.use('*', async (c, next) => {
  // Skip validation for health check and root
  if (c.req.path === '/health' || c.req.path === '/') {
    return next();
  }

  const missingSecrets: string[] = [];

  if (!c.env.RECIPIENT_ADDRESS) {
    missingSecrets.push('RECIPIENT_ADDRESS');
  }
  if (!c.env.OPENROUTER_API_KEY) {
    missingSecrets.push('OPENROUTER_API_KEY');
  }

  if (missingSecrets.length > 0) {
    return c.json({
      error: 'Server configuration error',
      message: \`Missing required secrets: \${missingSecrets.join(', ')}\`,
      hint: missingSecrets.map(s => \`Run: wrangler secret put \${s}\`).join(' && '),
    }, 503);
  }

  await next();
});

// Service info at root (free)
app.get('/', (c) => {
  return c.json({
    service: 'x402-ai-api',
    version: '1.0.0',
    defaultModel: '${defaultModel}',
    health: '/health',
    payment: {
      tokens: ['STX', 'sBTC', 'USDCx'],
      header: 'X-PAYMENT',
      tokenTypeHeader: 'X-PAYMENT-TOKEN-TYPE',
    },
  });
});

// Health check (free)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    network: c.env.NETWORK || 'testnet',
  });
});
${endpointCode}

export default app;
`;
}

function getOpenRouterTemplate(): string {
  return `/**
 * OpenRouter API Client
 * https://openrouter.ai/docs
 */

export interface OpenRouterRequest {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}

export interface OpenRouterResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface OpenRouterAPIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function callOpenRouter(request: OpenRouterRequest): Promise<OpenRouterResponse> {
  const {
    apiKey,
    model,
    systemPrompt,
    userMessage,
    maxTokens = 1024,
    temperature = 0.7,
  } = request;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${apiKey}\`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://aibtc.com',
      'X-Title': 'x402 AI Endpoint',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(\`OpenRouter API error: \${response.status} - \${error}\`);
  }

  const data = (await response.json()) as OpenRouterAPIResponse;

  return {
    content: data.choices[0]?.message?.content || '',
    model: data.model,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}
`;
}

function getAIPackageJsonTemplate(projectName: string): string {
  return `{
  "name": "${projectName}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "tail": "wrangler tail",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250109.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.56.0"
  }
}
`;
}

function getAIEnvExampleTemplate(recipientAddress?: string): string {
  const addressNote = recipientAddress
    ? `# Value: ${recipientAddress}`
    : "# Value: Your Stacks address (SP... for mainnet, ST... for testnet)";
  return `# Cloudflare credentials (only needed for CI/CD deployment)
# For local dev, wrangler uses browser-based auth
CLOUDFLARE_API_TOKEN=your-api-token-here
CLOUDFLARE_ACCOUNT_ID=your-account-id-here

# x402 recipient address (set via wrangler secret)
# wrangler secret put RECIPIENT_ADDRESS
${addressNote}

# OpenRouter API key (set via wrangler secret)
# Get your key at https://openrouter.ai/keys
# wrangler secret put OPENROUTER_API_KEY
`;
}

function getAIDevVarsTemplate(recipientAddress?: string): string {
  const address = recipientAddress || "YOUR_STACKS_ADDRESS_HERE";
  return `# Local development variables
# These are used by wrangler dev and are NOT deployed to production
# For production secrets, use: wrangler secret put <SECRET_NAME>

RECIPIENT_ADDRESS=${address}
OPENROUTER_API_KEY=your-openrouter-key-here
`;
}

function getAIReadmeTemplate(
  projectName: string,
  endpoints: AIEndpointConfig[],
  recipientAddress?: string,
  defaultModel?: string
): string {
  const tokenList = [...new Set(endpoints.map((ep) => `- ${ep.tokenType}`))].join("\n");
  const endpointDocs = generateAIEndpointDocs(endpoints);
  const addressDisplay = recipientAddress || "YOUR_STACKS_ADDRESS";
  const modelDisplay = defaultModel || "anthropic/claude-3-haiku";

  return `# ${projectName}

x402-enabled AI API endpoints on Cloudflare Workers, powered by OpenRouter.

Built using patterns from:
- [x402-api](https://github.com/aibtcdev/x402-api)
- [stx402](https://github.com/whoabuddy/stx402)

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Edit .dev.vars with your settings:
# - RECIPIENT_ADDRESS: Your Stacks address
# - OPENROUTER_API_KEY: Get from https://openrouter.ai/keys

# Start local dev server
npm run dev
\`\`\`

The server will start at http://localhost:8787

## AI Provider

This API uses [OpenRouter](https://openrouter.ai) to access AI models.
Default model: \`${modelDisplay}\`

## Payment Tokens

This API accepts payments in:
${tokenList}

## Endpoints

### GET /
- **Description:** Service info
- **Cost:** Free

### GET /health
- **Description:** Health check endpoint
- **Cost:** Free

${endpointDocs}

## Deployment

### Set Production Secrets

\`\`\`bash
# Set your recipient address (where payments will be sent)
wrangler secret put RECIPIENT_ADDRESS
# Enter: ${addressDisplay}

# Set your OpenRouter API key
wrangler secret put OPENROUTER_API_KEY
# Enter: your-api-key-from-openrouter.ai/keys
\`\`\`

### Deploy

\`\`\`bash
# Deploy to staging (testnet)
npm run deploy:staging

# Deploy to production (mainnet)
npm run deploy:production
\`\`\`

## Example Usage

\`\`\`bash
# Service info (free)
curl http://localhost:8787/

# Health check (free)
curl http://localhost:8787/health

# AI endpoint (returns 402 without payment)
curl -X POST http://localhost:8787${endpoints[0]?.path || "/api/chat"} \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Hello, how are you?"}'
\`\`\`

## x402 Payment Flow

1. Client makes request without payment header
2. Server returns HTTP 402 with payment requirements
3. Client signs payment transaction (does NOT broadcast)
4. Client retries request with \`X-PAYMENT\` header containing signed tx
5. Server verifies and settles payment via relay
6. Server calls OpenRouter API and returns AI response

## Token Type Selection

Clients can specify which token to pay with using the \`X-PAYMENT-TOKEN-TYPE\` header:

\`\`\`bash
# Pay with sBTC instead of STX
curl -H "X-PAYMENT-TOKEN-TYPE: sBTC" -X POST http://localhost:8787${endpoints[0]?.path || "/api/chat"} \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Hello"}'
\`\`\`

Supported values: \`STX\`, \`sBTC\`, \`USDCx\`

## OpenRouter Models

Popular options:
- \`anthropic/claude-sonnet-4.5\` - Best overall, 1M context
- \`anthropic/claude-3.5-haiku\` - Fast and affordable
- \`openai/gpt-4o\` - OpenAI's latest
- \`openai/gpt-4o-mini\` - Fast and cheap
- \`google/gemini-2.5-flash\` - 1M context, fast
- \`deepseek/deepseek-r1\` - Excellent reasoning
- \`meta-llama/llama-3.3-70b-instruct\` - Best open source

See all models: https://openrouter.ai/models

## Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| \`INSUFFICIENT_FUNDS\` | Wallet needs funding | 402 |
| \`PAYMENT_EXPIRED\` | Sign a new payment | 402 |
| \`AMOUNT_TOO_LOW\` | Payment below minimum | 402 |
| \`PAYMENT_INVALID\` | Bad signature/params | 400 |
| \`NETWORK_ERROR\` | Transient error | 502 |
| \`RELAY_UNAVAILABLE\` | Try again later | 503 |

---

Generated with [@aibtc/mcp-server](https://www.npmjs.com/package/@aibtc/mcp-server) scaffold tool.
`;
}

// =============================================================================
// AI SCAFFOLD FUNCTION
// =============================================================================

export async function scaffoldAIProject(config: AIScaffoldConfig): Promise<ScaffoldResult> {
  const { outputDir, projectName, endpoints, recipientAddress, network, relayUrl, defaultModel } =
    config;

  await validateOutputDir(outputDir);

  const projectPath = path.join(outputDir, projectName);
  const filesCreated = await writeProjectFiles(projectPath, [
    { name: "src/index.ts", content: getAIIndexTemplate(endpoints, defaultModel) },
    { name: "src/x402-middleware.ts", content: getMiddlewareTemplate() },
    { name: "src/openrouter.ts", content: getOpenRouterTemplate() },
    { name: "wrangler.jsonc", content: getWranglerTemplate(projectName, network, relayUrl) },
    { name: "package.json", content: getAIPackageJsonTemplate(projectName) },
    { name: "tsconfig.json", content: getTsconfigTemplate() },
    { name: ".env.example", content: getAIEnvExampleTemplate(recipientAddress) },
    { name: ".dev.vars", content: getAIDevVarsTemplate(recipientAddress) },
    { name: ".gitignore", content: getGitignoreTemplate() },
    {
      name: "README.md",
      content: getAIReadmeTemplate(projectName, endpoints, recipientAddress, defaultModel),
    },
  ]);

  return {
    projectPath,
    filesCreated,
    nextSteps: [
      `cd ${projectPath}`,
      "npm install",
      "# Edit .dev.vars with your RECIPIENT_ADDRESS and OPENROUTER_API_KEY",
      "npm run dev",
      "# For production deployment:",
      getAddressInstruction(recipientAddress),
      "wrangler secret put OPENROUTER_API_KEY (get from https://openrouter.ai/keys)",
      "npm run deploy:production",
    ],
  };
}
