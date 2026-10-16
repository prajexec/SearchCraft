import type { FieldValue } from '../indexes/index-config';

export type ExactFilterValue = string | number | boolean;

export interface RangeFilterValue {
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
}

export type FilterClause = ExactFilterValue | RangeFilterValue;
export type SearchFilters = Readonly<Record<string, FilterClause>>;

export class FilterValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FilterValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactValue(value: unknown): value is ExactFilterValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function parseClause(fieldName: string, value: unknown): FilterClause {
  if (isExactValue(value)) {
    return value;
  }
  if (!isRecord(value)) {
    throw new FilterValidationError(`Filter for "${fieldName}" must be a scalar or numeric range`);
  }

  const allowedOperators = new Set(['gt', 'gte', 'lt', 'lte']);
  const operators = Object.keys(value);
  if (operators.length === 0 || operators.some((operator) => !allowedOperators.has(operator))) {
    throw new FilterValidationError(`Filter range for "${fieldName}" has an unsupported operator`);
  }

  const range: Record<string, number> = {};
  for (const operator of operators) {
    const operand = value[operator];
    if (typeof operand !== 'number' || !Number.isFinite(operand)) {
      throw new FilterValidationError(
        `Filter range operand "${fieldName}.${operator}" must be finite`,
      );
    }
    range[operator] = operand;
  }
  return range as RangeFilterValue;
}

export function parseFilters(
  rawValue: string | undefined,
  allowedFields: readonly string[],
): SearchFilters {
  if (rawValue === undefined || rawValue === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue) as unknown;
  } catch {
    throw new FilterValidationError('filter must be valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new FilterValidationError('filter must be a JSON object');
  }

  const allowed = new Set(allowedFields);
  const filters: Record<string, FilterClause> = {};
  for (const [fieldName, value] of Object.entries(parsed)) {
    if (!allowed.has(fieldName)) {
      throw new FilterValidationError(`Field "${fieldName}" is not configured as filterable`);
    }
    filters[fieldName] = parseClause(fieldName, value);
  }
  return filters;
}

function exactMatches(value: FieldValue | undefined, expected: ExactFilterValue): boolean {
  if (Array.isArray(value)) {
    return typeof expected === 'string' && value.includes(expected);
  }
  return value === expected;
}

function rangeMatches(value: FieldValue | undefined, range: RangeFilterValue): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  if (range.gt !== undefined && value <= range.gt) {
    return false;
  }
  if (range.gte !== undefined && value < range.gte) {
    return false;
  }
  if (range.lt !== undefined && value >= range.lt) {
    return false;
  }
  if (range.lte !== undefined && value > range.lte) {
    return false;
  }
  return true;
}

export function matchesFilters(
  fields: Record<string, FieldValue>,
  filters: SearchFilters,
): boolean {
  return Object.entries(filters).every(([fieldName, clause]) => {
    const value = fields[fieldName];
    return isExactValue(clause) ? exactMatches(value, clause) : rangeMatches(value, clause);
  });
}
