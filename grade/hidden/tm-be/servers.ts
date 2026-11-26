// Helpers that run the solution as real server processes (`bun <SOLUTION_DIR>/src/main.ts`).
import { MAIN_PATH, SOLUTION_DIR, type FeeConfig, SECRET, type SendOptions, toReply, webhookRequest, type EventBody, type Reply } from "./support.ts";

export type ServerProcess = {
  port: number;
  baseUrl: string;
  process: ReturnType<typeof Bun.spawn>;
  stderrText(): Promise<string>;
  send(event: EventBody | string, options?: SendOptions): Promise<Reply>;
  get(path: string): Promise<Reply>;
};

const READY_TIMEOUT_MS = 20_000;

/** Reserves `count` distinct free TCP ports at once, then releases them for the children to bind. */
export function reserveFreePorts(count: number): number[] {
  const holders = Array.from({ length: count }, () => Bun.serve({ port: 0, fetch: () => new Response("") }));
  const ports = holders.map((holder) => holder.port as number);
  for (const holder of holders) holder.stop(true);
  return ports;
}

export function spawnMain(env: Record<string, string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, MAIN_PATH], {
    cwd: SOLUTION_DIR,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function waitUntilListening(server: { port: number; process: ReturnType<typeof Bun.spawn> }): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.process.exitCode !== null) {
      const stderr = await new Response(server.process.stderr as ReadableStream).text();
      throw new Error(`server process on port ${server.port} exited with code ${server.process.exitCode} before listening: ${stderr.slice(0, 500)}`);
    }
    try {
      await fetch(`http://127.0.0.1:${server.port}/balances/readiness-probe`);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`server process on port ${server.port} did not listen within ${READY_TIMEOUT_MS} ms`);
}

/**
 * Starts `count` server processes at the same moment on one database path.
 * The signed requests use the real clock: a child process cannot be given an injected `now`.
 * Always kills every child, also when `run` throws or times out its test.
 */
export async function withServers(
  count: number,
  options: { dbPath: string; fees: FeeConfig },
  run: (servers: ServerProcess[]) => Promise<void>,
): Promise<void> {
  const ports = reserveFreePorts(count);
  const servers: ServerProcess[] = ports.map((port) => {
    const child = spawnMain({
      PORT: String(port),
      DB_PATH: options.dbPath,
      WEBHOOK_SECRET: SECRET,
      FEES_JSON: JSON.stringify(options.fees),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    return {
      port,
      baseUrl,
      process: child,
      stderrText: () => new Response(child.stderr as ReadableStream).text(),
      send: async (event, sendOptions = {}) => {
        const raw = typeof event === "string" ? event : JSON.stringify(event);
        return toReply(await fetch(webhookRequest(baseUrl, raw, sendOptions, String(Math.floor(Date.now() / 1000)))));
      },
      get: async (path) => toReply(await fetch(`${baseUrl}${path}`)),
    };
  });
  try {
    await Promise.all(servers.map(waitUntilListening));
    await run(servers);
  } finally {
    for (const server of servers) server.process.kill("SIGKILL");
    await Promise.all(servers.map((server) => server.process.exited));
  }
}
