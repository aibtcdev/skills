import {
  ClarityValue,
  stringAsciiCV,
  stringUtf8CV,
  intCV,
  uintCV,
  boolCV,
  principalCV,
  bufferCV,
  listCV,
  tupleCV,
  noneCV,
  someCV,
  cvToString,
  cvToJSON,
  deserializeCV,
  serializeCV,
} from "@stacks/transactions";

/**
 * Parse a JSON argument into a ClarityValue
 * Supports: string, number, boolean, principal, buffer, list, tuple, optional
 */
export function parseArgToClarityValue(arg: unknown): ClarityValue {
  if (arg === null || arg === undefined) {
    return noneCV();
  }

  if (typeof arg === "boolean") {
    return boolCV(arg);
  }

  if (typeof arg === "number") {
    if (Number.isInteger(arg)) {
      return arg >= 0 ? uintCV(arg) : intCV(arg);
    }
    throw new Error("Floating point numbers not supported in Clarity");
  }

  if (typeof arg === "string") {
    // Check if it's a principal (Stacks address pattern)
    if (arg.match(/^S[A-Z0-9]{38,}(\.[a-zA-Z][a-zA-Z0-9-]*)?$/)) {
      return principalCV(arg);
    }
    // Default to string-utf8
    return stringUtf8CV(arg);
  }

  if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) {
    return bufferCV(arg as Uint8Array);
  }

  if (Array.isArray(arg)) {
    return listCV(arg.map(parseArgToClarityValue));
  }

  if (typeof arg === "object") {
    const obj = arg as Record<string, unknown>;

    // Check for typed values with explicit type field
    if ("type" in obj && "value" in obj) {
      const typedArg = obj as { type: string; value: unknown };
      switch (typedArg.type) {
        case "uint":
          return uintCV(BigInt(typedArg.value as string | number));
        case "int":
          return intCV(BigInt(typedArg.value as string | number));
        case "string-ascii":
          return stringAsciiCV(typedArg.value as string);
        case "string-utf8":
          return stringUtf8CV(typedArg.value as string);
        case "bool":
          return boolCV(typedArg.value as boolean);
        case "principal":
          return principalCV(typedArg.value as string);
        case "buffer":
          return bufferCV(Buffer.from(typedArg.value as string, "hex"));
        case "none":
          return noneCV();
        case "some":
          return someCV(parseArgToClarityValue(typedArg.value));
        case "list":
          return listCV(
            (typedArg.value as unknown[]).map(parseArgToClarityValue)
          );
        case "tuple": {
          const tupleData: Record<string, ClarityValue> = {};
          for (const [key, val] of Object.entries(
            typedArg.value as Record<string, unknown>
          )) {
            tupleData[key] = parseArgToClarityValue(val);
          }
          return tupleCV(tupleData);
        }
        default:
          throw new Error(`Unknown type: ${typedArg.type}`);
      }
    }

    // Treat as tuple
    const tupleData: Record<string, ClarityValue> = {};
    for (const [key, val] of Object.entries(obj)) {
      tupleData[key] = parseArgToClarityValue(val);
    }
    return tupleCV(tupleData);
  }

  throw new Error(
    `Cannot convert argument to ClarityValue: ${JSON.stringify(arg)}`
  );
}

/**
 * Convert a ClarityValue to a human-readable string
 */
export function clarityToString(cv: ClarityValue): string {
  return cvToString(cv);
}

/**
 * Convert a ClarityValue to JSON
 */
export function clarityToJSON(cv: ClarityValue): unknown {
  return cvToJSON(cv);
}

/**
 * Serialize a ClarityValue to hex string
 */
export function serializeClarityValue(cv: ClarityValue): string {
  return Buffer.from(serializeCV(cv)).toString("hex");
}

/**
 * Deserialize a hex string to ClarityValue
 */
export function deserializeClarityValue(hex: string): ClarityValue {
  return deserializeCV(Buffer.from(hex, "hex"));
}

/**
 * Create a uint ClarityValue from a number or string
 */
export function createUint(value: number | string | bigint): ClarityValue {
  return uintCV(BigInt(value));
}

/**
 * Create an int ClarityValue from a number or string
 */
export function createInt(value: number | string | bigint): ClarityValue {
  return intCV(BigInt(value));
}

/**
 * Create a principal ClarityValue
 */
export function createPrincipal(address: string): ClarityValue {
  return principalCV(address);
}

/**
 * Create a string-ascii ClarityValue
 */
export function createStringAscii(str: string): ClarityValue {
  return stringAsciiCV(str);
}

/**
 * Create a string-utf8 ClarityValue
 */
export function createStringUtf8(str: string): ClarityValue {
  return stringUtf8CV(str);
}

/**
 * Create a bool ClarityValue
 */
export function createBool(value: boolean): ClarityValue {
  return boolCV(value);
}

/**
 * Create a buffer ClarityValue from hex string
 */
export function createBuffer(hex: string): ClarityValue {
  return bufferCV(Buffer.from(hex, "hex"));
}

/**
 * Create a list ClarityValue
 */
export function createList(items: ClarityValue[]): ClarityValue {
  return listCV(items);
}

/**
 * Create a tuple ClarityValue
 */
export function createTuple(data: Record<string, ClarityValue>): ClarityValue {
  return tupleCV(data);
}

/**
 * Create a none ClarityValue
 */
export function createNone(): ClarityValue {
  return noneCV();
}

/**
 * Create a some ClarityValue
 */
export function createSome(value: ClarityValue): ClarityValue {
  return someCV(value);
}
