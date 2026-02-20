/**
 * Result<T, E> — discriminated union for explicit ok/err returns.
 *
 * Provides a Railway-Oriented Programming (ROP) style alternative to throw/catch
 * for operations where callers should handle both success and failure paths explicitly.
 *
 * Usage:
 *   const result = await tryCatch(() => fetchData());
 *   if (isOk(result)) {
 *     console.log(result.value);
 *   } else {
 *     console.error(result.error.message);
 *   }
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a successful operation with a value of type T.
 */
export interface OkResult<T> {
  success: true;
  value: T;
}

/**
 * Represents a failed operation with an error of type E.
 */
export interface ErrResult<E> {
  success: false;
  error: E;
}

/**
 * A discriminated union that is either an OkResult<T> or an ErrResult<E>.
 * Defaults to Error as the error type when E is not specified.
 *
 * Use the isOk() and isErr() type guards to narrow the union.
 */
export type Result<T, E = Error> = OkResult<T> | ErrResult<E>;

// ============================================================================
// Constructors
// ============================================================================

/**
 * Wrap a success value in an OkResult.
 *
 * @param value - The successful result value.
 * @returns An OkResult containing the value.
 *
 * @example
 *   return ok({ address: "SP1..." });
 */
export function ok<T>(value: T): OkResult<T> {
  return { success: true, value };
}

/**
 * Wrap an error in an ErrResult.
 *
 * @param error - The error value (defaults to Error type).
 * @returns An ErrResult containing the error.
 *
 * @example
 *   return err(new WalletNotFoundError(walletId));
 */
export function err<E = Error>(error: E): ErrResult<E> {
  return { success: false, error };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Narrow a Result to OkResult when the operation succeeded.
 *
 * @param result - The Result to check.
 * @returns true when result.success is true, narrowing to OkResult<T>.
 *
 * @example
 *   if (isOk(result)) {
 *     console.log(result.value); // T is accessible
 *   }
 */
export function isOk<T, E>(result: Result<T, E>): result is OkResult<T> {
  return result.success === true;
}

/**
 * Narrow a Result to ErrResult when the operation failed.
 *
 * @param result - The Result to check.
 * @returns true when result.success is false, narrowing to ErrResult<E>.
 *
 * @example
 *   if (isErr(result)) {
 *     console.error(result.error.message); // E is accessible
 *   }
 */
export function isErr<T, E>(result: Result<T, E>): result is ErrResult<E> {
  return result.success === false;
}

// ============================================================================
// Try-Catch Wrappers
// ============================================================================

/**
 * Run an async function and return a Result instead of throwing.
 *
 * Catches any thrown value. If the thrown value is already an Error it is used
 * directly; otherwise it is converted to an Error via String().
 *
 * @param fn - An async factory that may throw.
 * @returns A Promise that resolves to ok(value) on success or err(error) on failure.
 *
 * @example
 *   const result = await tryCatch(() => hiroApi.getBalance(address));
 *   if (isErr(result)) return { error: result.error.message };
 */
export async function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (thrown) {
    if (thrown instanceof Error) {
      return err(thrown);
    }
    return err(new Error(String(thrown)));
  }
}

/**
 * Run a synchronous function and return a Result instead of throwing.
 *
 * Catches any thrown value. If the thrown value is already an Error it is used
 * directly; otherwise it is converted to an Error via String().
 *
 * @param fn - A synchronous factory that may throw.
 * @returns ok(value) on success or err(error) on failure.
 *
 * @example
 *   const result = tryCatchSync(() => JSON.parse(rawInput));
 *   if (isErr(result)) return { error: "Invalid JSON" };
 */
export function tryCatchSync<T>(fn: () => T): Result<T, Error> {
  try {
    const value = fn();
    return ok(value);
  } catch (thrown) {
    if (thrown instanceof Error) {
      return err(thrown);
    }
    return err(new Error(String(thrown)));
  }
}
