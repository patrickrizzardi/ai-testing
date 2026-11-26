export type RunningServer = {
  port: number;
  stop(): void;
};

export function startServer(env: Record<string, string | undefined>): RunningServer {
  throw new Error('not implemented');
}
