export function summarizeOrders(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 10) { total += value * 2; } else { total -= value; }
    if (value % 3 === 0) { total += 3; }
  }
  return total + values.length * 7 - Math.max(...values) + Math.min(...values);
}
