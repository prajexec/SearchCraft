export type FieldValue = string | number | boolean | readonly string[];

export interface SearchDocument {
  readonly id: string;
  readonly fields: Record<string, FieldValue>;
}

export interface SearchableFieldConfig {
  readonly boost: number;
}

export interface IndexConfig {
  readonly searchableFields: Readonly<Record<string, SearchableFieldConfig>>;
  readonly storedFields: readonly string[];
  readonly maxTokenLength: number;
  readonly filterableFields?: readonly string[];
  readonly maxQueryTerms?: number;
}

export interface IndexMetadata {
  readonly name: string;
  readonly config: IndexConfig;
  readonly state: string;
  readonly activeGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFieldName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new ValidationError(
      `Field name "${name}" must contain only letters, numbers, underscores, or hyphens`,
    );
  }
}

export function validateIndexName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new ValidationError(
      'Index name must start with a letter or number and contain only letters, numbers, underscores, or hyphens',
    );
  }
}

export function validateDocumentId(id: string): void {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    throw new ValidationError(
      'Document ID must start with a letter or number and contain only letters, numbers, dots, underscores, colons, or hyphens',
    );
  }
}

export function parseIndexConfig(value: unknown): IndexConfig {
  if (!isRecord(value)) {
    throw new ValidationError('Index configuration must be a JSON object');
  }

  const searchableFieldsValue = value.searchableFields;
  if (!isRecord(searchableFieldsValue) || Object.keys(searchableFieldsValue).length === 0) {
    throw new ValidationError('searchableFields must contain at least one field');
  }

  const searchableFields: Record<string, SearchableFieldConfig> = {};
  for (const [fieldName, fieldConfig] of Object.entries(searchableFieldsValue)) {
    validateFieldName(fieldName);
    if (!isRecord(fieldConfig)) {
      throw new ValidationError(
        `Configuration for searchable field "${fieldName}" must be an object`,
      );
    }
    const boost = fieldConfig.boost ?? 1;
    if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0 || boost > 100) {
      throw new ValidationError(
        `Boost for searchable field "${fieldName}" must be between 0 and 100`,
      );
    }
    searchableFields[fieldName] = { boost };
  }

  const storedFieldsValue = value.storedFields;
  const storedFields =
    storedFieldsValue === undefined ? Object.keys(searchableFields) : storedFieldsValue;
  if (
    !Array.isArray(storedFields) ||
    storedFields.some(
      (fieldName) => typeof fieldName !== 'string' || !IDENTIFIER_PATTERN.test(fieldName),
    )
  ) {
    throw new ValidationError('storedFields must be an array of valid field names');
  }
  for (const fieldName of storedFields) {
    validateFieldName(fieldName);
  }

  const filterableFieldsValue = value.filterableFields ?? [];
  if (
    !Array.isArray(filterableFieldsValue) ||
    filterableFieldsValue.some(
      (fieldName) => typeof fieldName !== 'string' || !IDENTIFIER_PATTERN.test(fieldName),
    )
  ) {
    throw new ValidationError('filterableFields must be an array of valid field names');
  }
  for (const fieldName of filterableFieldsValue) {
    validateFieldName(fieldName);
  }

  const maxTokenLengthValue = value.maxTokenLength ?? 128;
  if (
    typeof maxTokenLengthValue !== 'number' ||
    !Number.isSafeInteger(maxTokenLengthValue) ||
    maxTokenLengthValue < 8 ||
    maxTokenLengthValue > 1_024
  ) {
    throw new ValidationError('maxTokenLength must be an integer between 8 and 1024');
  }

  const maxQueryTermsValue = value.maxQueryTerms ?? 32;
  if (
    typeof maxQueryTermsValue !== 'number' ||
    !Number.isSafeInteger(maxQueryTermsValue) ||
    maxQueryTermsValue < 1 ||
    maxQueryTermsValue > 256
  ) {
    throw new ValidationError('maxQueryTerms must be an integer between 1 and 256');
  }

  return {
    searchableFields,
    storedFields: [...new Set(storedFields)],
    maxTokenLength: maxTokenLengthValue,
    filterableFields: [...new Set(filterableFieldsValue)],
    maxQueryTerms: maxQueryTermsValue,
  };
}

function isFieldValue(value: unknown): value is FieldValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseSearchDocument(value: unknown, expectedId: string): SearchDocument {
  validateDocumentId(expectedId);
  if (!isRecord(value)) {
    throw new ValidationError('Document body must be a JSON object');
  }
  if (value.id !== undefined && value.id !== expectedId) {
    throw new ValidationError('Document body id must match the URL document ID');
  }
  if (!isRecord(value.fields) || Object.keys(value.fields).length === 0) {
    throw new ValidationError('Document fields must contain at least one field');
  }

  for (const [fieldName, fieldValue] of Object.entries(value.fields)) {
    validateFieldName(fieldName);
    if (!isFieldValue(fieldValue)) {
      throw new ValidationError(
        `Field "${fieldName}" must be a string, number, boolean, or string array`,
      );
    }
  }

  return {
    id: expectedId,
    fields: value.fields as Record<string, FieldValue>,
  };
}
