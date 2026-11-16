import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { _testing as storageTesting, getHiroApiKey } from "../utils/storage.js";
import { getStacksClient } from "./hiro-api.js";

describe("getStacksClient", () => {
  const savedKey = process.env.HIRO_API_KEY;
  afterEach(() => {
    storageTesting.overrideStacksApiUrl(null);
    if (savedKey === undefined) delete process.env.HIRO_API_KEY;
    else process.env.HIRO_API_KEY = savedKey;
  });

  test("uses the configured Stacks API URL and sends the Hiro API key", async () => {
    const seen: Array<{ path: string; key: string | undefined; accept: string | undefined }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push({
        path: req.url ?? "",
        key: req.headers["x-hiro-api-key"] as string | undefined,
        accept: req.headers["accept"] as string | undefined,
      });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      storageTesting.overrideStacksApiUrl(origin);
      process.env.HIRO_API_KEY = "test-key";

      const client = await getStacksClient("testnet");
      expect(client.baseUrl).toBe(origin);
      await client.fetch(`${client.baseUrl}/v2/info`, { headers: { Accept: "application/text" } });
      // A key saved in ~/.aibtc/config.json takes precedence over HIRO_API_KEY.
      const expectedKey = (await getHiroApiKey()) || "test-key";
      // The caller's own headers are kept alongside the key.
      expect(seen).toEqual([{ path: "/v2/info", key: expectedKey, accept: "application/text" }]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

});
