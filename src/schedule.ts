/** SQL timestamps in the bot are UTC. Validate the window before persisting it. */
export function scheduleError(endsAt?: string | null, startsAt?: string | null): string | null {
  const parse = (value: string) => Date.parse(/[zZ]$/.test(value) ? value : value + "Z");
  if ((endsAt && !Number.isFinite(parse(endsAt))) || (startsAt && !Number.isFinite(parse(startsAt)))) return "Choose a valid start and closing time.";
  if (endsAt && startsAt && parse(endsAt) <= parse(startsAt)) return "The closing time must be after the scheduled start. Change either time and try again.";
  return null;
}
