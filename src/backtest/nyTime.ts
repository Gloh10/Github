const nyHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

/** Hour-of-day (0-23) in America/New_York, DST-aware. */
export function nyHour(unixSeconds: number): number {
  return Number(nyHourFormatter.format(new Date(unixSeconds * 1000)));
}

const nyDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }); // en-CA -> YYYY-MM-DD

export function nyDateKey(unixSeconds: number): string {
  return nyDateFormatter.format(new Date(unixSeconds * 1000));
}

const nyMinuteFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", minute: "numeric" });

/** Minute-of-hour (0-59) in America/New_York. */
export function nyMinute(unixSeconds: number): number {
  return Number(nyMinuteFormatter.format(new Date(unixSeconds * 1000)));
}

const nyWeekdayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of week (0=Sunday..6=Saturday) in America/New_York, DST-aware. */
export function nyWeekday(unixSeconds: number): number {
  return WEEKDAY_INDEX[nyWeekdayFormatter.format(new Date(unixSeconds * 1000))]!;
}
