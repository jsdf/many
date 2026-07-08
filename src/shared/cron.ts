// Standard 5-field cron expression matcher (min hour dom month dow).
// No external dependency - evaluated per-minute against local time.
// Supports: *, a, a-b, */n, a-b/n, and comma-separated lists of the above.

interface FieldSpec {
  min: number;
  max: number;
  /** Values outside [min, max] that are still accepted and folded onto another value. */
  alias?: { value: number; foldsTo: number };
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6, alias: { value: 7, foldsTo: 0 } }, // day of week (0 = Sunday, 7 also Sunday)
];

// Parse a single part (no commas) of a field into the set of matching values
// (already folded via the field's alias, e.g. dow 7 -> 0), or null if invalid.
function parsePart(part: string, spec: FieldSpec): Set<number> | null {
  let step = 1;
  let rangePart = part;

  const slashIdx = part.indexOf("/");
  if (slashIdx !== -1) {
    rangePart = part.slice(0, slashIdx);
    const stepStr = part.slice(slashIdx + 1);
    if (!/^\d+$/.test(stepStr)) return null;
    step = parseInt(stepStr, 10);
    if (step <= 0) return null;
  }

  const parseableMax = spec.alias ? spec.alias.value : spec.max;

  let lo: number;
  let hi: number;

  if (rangePart === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (/^\d+-\d+$/.test(rangePart)) {
    const [loStr, hiStr] = rangePart.split("-");
    lo = parseInt(loStr, 10);
    hi = parseInt(hiStr, 10);
    if (lo > hi) return null;
  } else if (/^\d+$/.test(rangePart)) {
    lo = hi = parseInt(rangePart, 10);
  } else {
    return null;
  }

  if (lo < spec.min || hi > parseableMax) return null;

  const values = new Set<number>();
  for (let v = lo; v <= hi; v += step) {
    values.add(spec.alias && v === spec.alias.value ? spec.alias.foldsTo : v);
  }
  return values;
}

// Parse a full field (may contain commas) into the set of matching values, or null if invalid.
function parseField(field: string, spec: FieldSpec): Set<number> | null {
  if (field.length === 0) return null;
  const parts = field.split(",");
  const values = new Set<number>();
  for (const part of parts) {
    const partValues = parsePart(part, spec);
    if (!partValues) return null;
    for (const v of partValues) values.add(v);
  }
  return values;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

function parseExpr(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0], FIELD_SPECS[0]);
  const hour = parseField(fields[1], FIELD_SPECS[1]);
  const dom = parseField(fields[2], FIELD_SPECS[2]);
  const month = parseField(fields[3], FIELD_SPECS[3]);
  const dow = parseField(fields[4], FIELD_SPECS[4]);

  if (!minute || !hour || !dom || !month || !dow) return null;

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*",
  };
}

export function isValidCron(expr: string): boolean {
  return parseExpr(expr) !== null;
}

export function cronMatches(expr: string, date: Date): boolean {
  const parsed = parseExpr(expr);
  if (!parsed) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  if (!parsed.minute.has(minute) || !parsed.hour.has(hour) || !parsed.month.has(month)) {
    return false;
  }

  const domMatches = parsed.dom.has(dom);
  const dowMatches = parsed.dow.has(dow);

  // Standard cron day rule: if both DOM and DOW are restricted (neither is `*`),
  // the day matches if EITHER matches; otherwise both must match.
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatches || dowMatches;
  }
  return domMatches && dowMatches;
}
