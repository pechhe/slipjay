import { createServer } from "node:http";
import { once } from "node:events";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { RunnerHandler } from "./runner-contract.ts";

export async function serveRunner(handler: RunnerHandler, options: { host: string; port: number }): Promise<{ port: number; url: string; close(): Promise<void> }> {
  if (!["127.0.0.1", "::1", "localhost"].includes(options.host))
    throw new Error("Runner must listen on a loopback host");
  const hostname = options.host === "::1" ? "[::1]" : options.host;
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.once("close", () => abort.abort());
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      const method = incoming.method ?? "GET";
      const chunks: Buffer[] = [];
      if (method !== "GET" && method !== "HEAD") {
        for await (const chunk of incoming)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const request = new Request(`http://${hostname}:${options.port}${incoming.url ?? "/"}`, {
        method, headers, signal: abort.signal,
        ...method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) },
      });
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.flushHeaders();
      if (response.body) {
        const bodyReader = response.body.getReader();
        reader = bodyReader;
        const cancel = () => { void reader?.cancel().catch(() => {}); };
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await bodyReader.read();
            if (done)
              break;
            if (!outgoing.write(value))
              await once(outgoing, "drain", { signal: abort.signal });
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel);
        }
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        outgoing.destroy();
      }
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  });
  server.listen(options.port, options.host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Runner did not bind a TCP port");
  return {
    port: address.port,
    url: `http://${hostname}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
