import { daysInMonth } from './calendar.ts';
import { fail, succeed, type Result } from './result.ts';

const TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?(?:Z|(?<offsetSign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Parses an RFC 3339 timestamp with an offset into the epoch milliseconds of its instant.
 * Digits finer than a millisecond are dropped, which never moves an instant across a month
 * boundary. O(1) time and memory.
 */
export function parseSpentAt(text: string): Result<number, string> {
  const groups = TIMESTAMP_PATTERN.exec(text)?.groups;
  if (groups === undefined) return fail('must be an RFC 3339 timestamp with an offset');
  const readNumber = (groupName: string): number => Number(groups[groupName] ?? 0);

  const [year, month, day] = [readNumber('year'), readNumber('month'), readNumber('day')];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return fail('names a date that does not exist');
  const [hour, minute, second] = [readNumber('hour'), readNumber('minute'), readNumber('second')];
  if (hour > 23 || minute > 59 || second > 59) return fail('names a time that does not exist');
  const [offsetHour, offsetMinute] = [readNumber('offsetHour'), readNumber('offsetMinute')];
  if (offsetHour > 23 || offsetMinute > 59) return fail('has an offset that does not exist');

  const milliseconds = Number((groups['fraction'] ?? '').padEnd(3, '0').slice(0, 3));
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  localAsUtc.setUTCHours(hour, minute, second, milliseconds);
  const offsetSign = groups['offsetSign'] === '-' ? -1 : 1;
  const offsetMs = offsetSign * (offsetHour * 60 + offsetMinute) * MILLISECONDS_PER_MINUTE;
  return succeed(localAsUtc.getTime() - offsetMs);
}
