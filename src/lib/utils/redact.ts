/**
 * Redact sensitive values from strings before logging
 */

/**
 * Redacts sensitive values from JSON-like strings
 * Matches patterns like "password":"value", "mnemonic":"value", "secret":"value"
 * and replaces the value portion with [REDACTED]
 */
export function redactSensitive(input: string): string {
  return input
    .replace(
      /"(password|mnemonic|secret|privateKey)"\s*:\s*"([^"]*)"/gi,
      '"$1":"[REDACTED]"'
    )
    .replace(
      /'(password|mnemonic|secret|privateKey)'\s*:\s*'([^']*)'/gi,
      "'$1':'[REDACTED]'"
    )
    .replace(
      /(password|mnemonic|secret|privateKey)\s*:\s*"([^"]*)"/gi,
      "$1:\"[REDACTED]\""
    )
    .replace(
      /(password|mnemonic|secret|privateKey)\s*:\s*'([^']*)'/gi,
      "$1:'[REDACTED]'"
    );
}
