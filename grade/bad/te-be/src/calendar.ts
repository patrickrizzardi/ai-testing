import { fail, succeed, type Result } from './result.ts';

export type LocalDate = { year: number; month: number; day: number };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `month` is 1-12. O(1) time and memory. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/**
 * Accepts the zone names `Intl` accepts, minus offset-style text: `Intl` takes `+02:00`
 * as a zone, but the spec does not. O(1) time and memory.
 */
export function parseTimeZone(timeZone: string): Result<string, string> {
  const notAZoneName = 'is not an IANA time zone name';
  if (timeZone.startsWith('+') || timeZone.startsWith('-')) return fail(notAZoneName);
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return succeed(timeZone);
  } catch {
    return fail(notAZoneName);
  }
}

/**
 * Returns a reader of the calendar date an instant has in `timeZone`. `timeZone` must already
 * have passed `parseTimeZone`. Building the reader costs one `Intl.DateTimeFormat`; each read is
 * O(1) time and memory. Dates before year 1 are read as astronomical years (year 0, -1, ...).
 */
export function createLocalDateReader(timeZone: string): (epochMs: number) => LocalDate {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    era: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  return (epochMs) => {
    const parts = new Map(formatter.formatToParts(epochMs).map((part) => [part.type, part.value]));
    const yearOfEra = Number(parts.get('year'));
    return {
      year: parts.get('era') === 'BC' ? 1 - yearOfEra : yearOfEra,
      month: Number(parts.get('month')),
      day: Number(parts.get('day')),
    };
  };
}
