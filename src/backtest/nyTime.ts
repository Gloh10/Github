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
