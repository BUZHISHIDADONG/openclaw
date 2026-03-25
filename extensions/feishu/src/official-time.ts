type TimeRangeInput = {
  start?: string;
  end?: string;
};

function parseInputDate(input: string): Date | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);
  if (hasTimezone) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const normalized = trimmed.replace("T", " ");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second ?? "0"),
    ),
  );
}

export function parseTimeToTimestampSeconds(input: string): string | null {
  const date = parseInputDate(input);
  return date ? Math.floor(date.getTime() / 1000).toString() : null;
}

export function parseTimeToTimestampMs(input: string): string | null {
  const date = parseInputDate(input);
  return date ? date.getTime().toString() : null;
}

export function parseTimeToRFC3339(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : trimmed;
  }

  const normalized = trimmed.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}+08:00`;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function unixTimestampToISO8601(value?: string | number): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

export function convertTimeRangeToTimestamps(
  range: TimeRangeInput,
  unit: "s" | "ms" = "s",
): { start?: number; end?: number } {
  const convert = unit === "ms" ? parseTimeToTimestampMs : parseTimeToTimestampSeconds;
  const start = range.start ? convert(range.start) : null;
  const end = range.end ? convert(range.end) : null;
  return {
    ...(start ? { start: Number(start) } : {}),
    ...(end ? { end: Number(end) } : {}),
  };
}

function shiftRange(params: { amount: number; unit: "minutes" | "hours" | "days" }): {
  start: string;
  end: string;
} {
  const end = new Date();
  const start = new Date(end.getTime());
  const multipliers = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  };
  start.setTime(end.getTime() - params.amount * multipliers[params.unit]);
  return {
    start: Math.floor(start.getTime() / 1000).toString(),
    end: Math.floor(end.getTime() / 1000).toString(),
  };
}

export function parseRelativeTimeRange(value: string): { start: string; end: string } {
  const normalized = value.trim().toLowerCase();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);

  if (normalized === "today") {
    return {
      start: Math.floor(todayStart.getTime() / 1000).toString(),
      end: Math.floor(tomorrowStart.getTime() / 1000).toString(),
    };
  }

  if (normalized === "yesterday") {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - 1);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(todayStart.getTime() / 1000).toString(),
    };
  }

  if (normalized === "day_before_yesterday") {
    const end = new Date(todayStart);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(end.getTime() / 1000).toString(),
    };
  }

  if (normalized === "this_week") {
    const start = new Date(todayStart);
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(tomorrowStart.getTime() / 1000).toString(),
    };
  }

  if (normalized === "last_week") {
    const end = new Date(todayStart);
    const start = new Date(todayStart);
    const day = (start.getDay() + 6) % 7;
    end.setDate(end.getDate() - day);
    start.setTime(end.getTime());
    start.setDate(start.getDate() - 7);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(end.getTime() / 1000).toString(),
    };
  }

  if (normalized === "this_month") {
    const start = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(tomorrowStart.getTime() / 1000).toString(),
    };
  }

  if (normalized === "last_month") {
    const start = new Date(todayStart.getFullYear(), todayStart.getMonth() - 1, 1);
    const end = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    return {
      start: Math.floor(start.getTime() / 1000).toString(),
      end: Math.floor(end.getTime() / 1000).toString(),
    };
  }

  const relativeMatch = normalized.match(/^last_(\d+)_(minutes|hours|days)$/);
  if (relativeMatch) {
    return shiftRange({
      amount: Number(relativeMatch[1]),
      unit: relativeMatch[2] as "minutes" | "hours" | "days",
    });
  }

  throw new Error(
    "Unsupported relative_time. Use today, yesterday, day_before_yesterday, this_week, last_week, this_month, last_month, or last_{N}_{minutes|hours|days}.",
  );
}
