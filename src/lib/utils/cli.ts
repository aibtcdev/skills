/**
 * Shared CLI output helpers used by all skill CLI scripts.
 */

/**
 * Print any value as formatted JSON to stdout.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print an error as JSON and exit with code 1.
 */
export function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}
