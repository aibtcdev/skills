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
