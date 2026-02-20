/**
 * Shared CLI output helpers used by all skill CLI scripts.
 */

import { AibtcError } from "./errors.js";

/**
 * Print any value as formatted JSON to stdout.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print an error as JSON and exit with code 1.
 *
 * When the error is an AibtcError, the output includes structured fields
 * (code, suggestion, docsRef) so agents know what went wrong and what to do next.
 */
export function handleError(error: unknown): never {
  if (error instanceof AibtcError) {
    const output: Record<string, unknown> = {
      error: error.message,
      code: error.code,
      suggestion: error.suggestion,
    };
    if (error.docsRef !== undefined) {
      output.docsRef = error.docsRef;
    }
    if (error.details !== undefined) {
      output.details = error.details;
    }
    printJson(output);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    printJson({ error: message });
  }
  process.exit(1);
}
