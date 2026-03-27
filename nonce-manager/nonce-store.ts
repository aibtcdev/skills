/**
 * Nonce Store — re-exports from shared nonce tracker.
 *
 * The nonce oracle implementation lives in src/lib/services/nonce-tracker.ts
 * to be shared across all skills. This file provides the import path that
 * the nonce-manager CLI and AGENT.md integration examples reference.
 */

export {
  acquireNonce,
  releaseNonce,
  syncNonce,
  getStatus,
  type AcquireResult,
  type ReleaseResult,
  type SyncResult,
  type FailureKind,
  type AddressNonceState,
  type NonceStateFile,
} from "../src/lib/services/nonce-tracker.js";
