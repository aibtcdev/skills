import { describe, expect, test } from "bun:test";

function runSip018Hash(args: string[]) {
  const proc = Bun.spawnSync([
    "bun",
    "run",
    "signing/signing.ts",
    "sip018-hash",
    "--message",
    '{"amount":{"type":"uint","value":100},"memo":"hello"}',
    ...args,
  ]);

  const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
  const stderr = Buffer.from(proc.stderr).toString("utf8").trim();

  if (proc.exitCode !== 0) {
    throw new Error(`sip018-hash failed (${proc.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  return JSON.parse(stdout);
}

describe("signing/sip018 domain parameter alignment", () => {
  test("CLI flat domain flags and MCP-style --domain object produce identical hashes", () => {
    const viaCli = runSip018Hash([
      "--domain-name",
      "My App",
      "--domain-version",
      "1.0.0",
    ]);

    const viaMcpShape = runSip018Hash([
      "--domain",
      '{"name":"My App","version":"1.0.0"}',
    ]);

    expect(viaCli.success).toBe(true);
    expect(viaMcpShape.success).toBe(true);

    expect(viaCli.hashes).toEqual(viaMcpShape.hashes);
    expect(viaCli.domain).toEqual(viaMcpShape.domain);
  });

  test("MCP-style domain.chainId matches --chain-id behavior", () => {
    const viaCliChainOverride = runSip018Hash([
      "--domain-name",
      "My App",
      "--domain-version",
      "1.0.0",
      "--chain-id",
      "1",
    ]);

    const viaMcpDomainChainId = runSip018Hash([
      "--domain",
      '{"name":"My App","version":"1.0.0","chainId":1}',
    ]);

    expect(viaCliChainOverride.success).toBe(true);
    expect(viaMcpDomainChainId.success).toBe(true);

    expect(viaCliChainOverride.hashes).toEqual(viaMcpDomainChainId.hashes);
    expect(viaCliChainOverride.domain).toEqual(viaMcpDomainChainId.domain);
  });
});

// Regression tests for the `bool` type-hint coercion bug in
// signing/signing.ts `jsonToClarityValue` (see FINDING.md).
//
// Append these tests to signing/signing.test.ts (they reuse the file's
// existing `runSip018Hash` helper). Run with: bun test signing/signing.test.ts
//
// Expected behavior:
// - BEFORE the fix: test "string 'false' ..." FAILS (CLI exits 0, hashes the
//   message as `true`); test "numeric 0 ..." FAILS (CLI exits 0).
// - AFTER the fix: all 4 tests PASS (non-boolean bool values are rejected
//   with exit code 1; real booleans hash identically to implicit booleans).

function runSip018HashRaw(args: string[]) {
  const proc = Bun.spawnSync([
    "bun",
    "run",
    "signing/signing.ts",
    "sip018-hash",
    ...args,
  ]);

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8").trim(),
    stderr: Buffer.from(proc.stderr).toString("utf8").trim(),
  };
}

describe("signing/jsonToClarityValue bool hint validation", () => {
  const domainArgs = ["--domain-name", "My App", "--domain-version", "1.0.0"];

  test("string 'false' as bool value is rejected, not silently hashed as true", () => {
    const r = runSip018HashRaw([
      "--message",
      '{"flag":{"type":"bool","value":"false"}}',
      ...domainArgs,
    ]);
    // Pre-fix: exitCode is 0 and stdout contains success:true with the
    // hashes of {"flag":true}. Post-fix: exitCode 1 + error message.
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("bool type requires a boolean value");
  });

  test("numeric 0 as bool value is rejected", () => {
    const r = runSip018HashRaw([
      "--message",
      '{"flag":{"type":"bool","value":0}}',
      ...domainArgs,
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("bool type requires a boolean value");
  });

  test("real boolean false hashes the same as implicit false", () => {
    const viaHint = runSip018Hash([
      "--message",
      '{"flag":{"type":"bool","value":false}}',
      ...domainArgs,
    ]);
    const viaImplicit = runSip018Hash([
      "--message",
      '{"flag":false}',
      ...domainArgs,
    ]);
    expect(viaHint.success).toBe(true);
    expect(viaHint.hashes).toEqual(viaImplicit.hashes);
  });

  test("real boolean true hashes the same as implicit true", () => {
    const viaHint = runSip018Hash([
      "--message",
      '{"flag":{"type":"bool","value":true}}',
      ...domainArgs,
    ]);
    const viaImplicit = runSip018Hash([
      "--message",
      '{"flag":true}',
      ...domainArgs,
    ]);
    expect(viaHint.success).toBe(true);
    expect(viaHint.hashes).toEqual(viaImplicit.hashes);
  });
});
  
