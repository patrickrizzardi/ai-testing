export function add(left: number, right: number): number {
  return left + right;
}

export function parseCount(text: string): number {
  try {
    return JSON.parse(text) as number;
  } catch {
    return 0;
  }
}

export function ignoreFailure(job: Promise<void>): void {
  job.catch(() => {});
}
