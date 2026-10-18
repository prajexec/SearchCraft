export const openapiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'SearchCraft API',
    version: '0.1.0',
    description:
      'A lightweight, local-first search indexing and query service. The implemented slice provides named indexes, durable source documents, streaming NDJSON bulk ingestion, asynchronous custom indexing, BM25 search, cursor pagination, job inspection, and operational endpoints.',
  },
  servers: [{ url: 'http://127.0.0.1:3000' }],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Report process health',
        responses: {
          '200': { description: 'The process is running.' },
        },
      },
    },
    '/ready': {
      get: {
        operationId: 'getReadiness',
        summary: 'Report local storage readiness',
        responses: {
          '200': { description: 'Required local storage is available.' },
          '503': { description: 'Required local storage is unavailable.' },
        },
      },
    },
    '/metrics': {
      get: {
        operationId: 'getMetrics',
        summary: 'Return metrics as JSON',
        responses: {
          '200': { description: 'Current process metrics.' },
        },
      },
    },
    '/metrics/prometheus': {
      get: {
        operationId: 'getPrometheusMetrics',
        summary: 'Return metrics in Prometheus text format',
        responses: {
          '200': { description: 'Current process metrics.' },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiDocument',
        summary: 'Return the OpenAPI document',
        responses: {
          '200': { description: 'The current API specification.' },
        },
      },
    },
    '/v1/indexes': {
      get: {
        operationId: 'listIndexes',
        summary: 'List configured indexes',
        responses: {
          '200': {
            description: 'Configured indexes.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['indexes'],
                  properties: {
                    indexes: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/IndexMetadata' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createIndex',
        summary: 'Create a named search index',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateIndexRequest' },
              example: {
                name: 'products',
                config: {
                  searchableFields: { title: { boost: 2 }, description: { boost: 1 } },
                  storedFields: ['title', 'description'],
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Index created.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/IndexMetadata' } },
            },
          },
          '400': {
            description: 'Invalid index name or configuration.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '409': { description: 'An index with the name already exists.' },
        },
      },
    },
    '/v1/indexes/{index}': {
      parameters: [{ $ref: '#/components/parameters/IndexName' }],
      get: {
        operationId: 'getIndex',
        summary: 'Get index metadata',
        responses: {
          '200': {
            description: 'Index metadata.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/IndexMetadata' } },
            },
          },
          '404': { description: 'Index not found.' },
        },
      },
    },
    '/v1/indexes/{index}/documents/{id}': {
      parameters: [
        { $ref: '#/components/parameters/IndexName' },
        { $ref: '#/components/parameters/DocumentId' },
      ],
      get: {
        operationId: 'getDocument',
        summary: 'Read a durable source document',
        responses: {
          '200': {
            description: 'Source document and current version.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DocumentResponse' } },
            },
          },
          '404': { description: 'Index or document not found.' },
        },
      },
      put: {
        operationId: 'upsertDocument',
        summary: 'Upsert a document for asynchronous indexing',
        description:
          'The source document and indexing job are committed together. The production server returns before the worker publishes the index; poll the job or index status for visibility.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DocumentRequest' },
              example: { fields: { title: 'MacBook Air M1', description: 'Lightweight laptop' } },
            },
          },
        },
        responses: {
          '202': {
            description: 'Document durably accepted for indexing.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AsyncDocumentResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid document.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '404': { description: 'Index not found.' },
          '429': { description: 'The bounded indexing queue is full.' },
        },
      },
      delete: {
        operationId: 'deleteDocument',
        summary: 'Delete a document asynchronously',
        responses: {
          '202': {
            description: 'Document tombstone durably accepted for indexing.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AsyncDeleteResponse' } },
            },
          },
          '404': { description: 'Index not found.' },
          '429': { description: 'The bounded indexing queue is full.' },
        },
      },
    },
    '/v1/indexes/{index}/documents/_bulk': {
      parameters: [{ $ref: '#/components/parameters/IndexName' }],
      post: {
        operationId: 'bulkDocuments',
        summary: 'Ingest a bounded NDJSON document batch',
        description:
          'Accepts Elasticsearch-style two-line NDJSON actions. index, create, and update actions are followed by a source line; delete actions contain only metadata. The source documents and indexing jobs commit atomically as one batch.',
        requestBody: {
          required: true,
          content: {
            'application/x-ndjson': {
              schema: { type: 'string', format: 'binary' },
              example:
                '{"index":{"_id":"one"}}\n{"fields":{"title":"MacBook Air"}}\n{"delete":{"_id":"old"}}\n',
            },
          },
        },
        responses: {
          '200': {
            description: 'Batch synchronously indexed.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BulkResponse' } },
            },
          },
          '202': {
            description: 'Batch durably accepted for asynchronous indexing.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BulkResponse' } },
            },
          },
          '400': {
            description: 'Invalid NDJSON, action, document, or document ID.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '404': { description: 'Index not found.' },
          '409': { description: 'A create action conflicts or an update target is missing.' },
          '413': {
            description: 'The request body or operation count exceeds its configured limit.',
          },
          '415': { description: 'The request is not application/x-ndjson.' },
          '429': { description: 'The bounded indexing queue is full for the complete batch.' },
        },
      },
    },
    '/v1/indexes/{index}/search': {
      parameters: [{ $ref: '#/components/parameters/IndexName' }],
      get: {
        operationId: 'search',
        summary: 'Search an index with BM25 ranking',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 1000 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'filter',
            in: 'query',
            required: false,
            description:
              'URL-encoded JSON object of configured exact-match or numeric-range filters.',
            schema: { type: 'string' },
            example: '{"category":"laptop","price":{"gte":500}}',
          },
        ],
        responses: {
          '200': {
            description: 'Ranked search results.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } },
            },
          },
          '400': {
            description: 'Invalid query, limit, cursor, or filter.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '404': { description: 'Index not found.' },
        },
      },
    },
    '/v1/indexes/{index}/jobs': {
      parameters: [{ $ref: '#/components/parameters/IndexName' }],
      get: {
        operationId: 'listJobs',
        summary: 'List recent indexing jobs',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Recent jobs.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobs: { type: 'array', items: { $ref: '#/components/schemas/IndexingJob' } },
                  },
                },
              },
            },
          },
          '404': { description: 'Index not found.' },
        },
      },
    },
    '/v1/indexes/{index}/jobs/{jobId}': {
      parameters: [
        { $ref: '#/components/parameters/IndexName' },
        { $ref: '#/components/parameters/JobId' },
      ],
      get: {
        operationId: 'getJob',
        summary: 'Inspect one indexing job',
        responses: {
          '200': {
            description: 'Indexing job.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/IndexingJob' } },
            },
          },
          '404': { description: 'Job not found.' },
        },
      },
    },
    '/v1/indexes/{index}/jobs/{jobId}/retry': {
      parameters: [
        { $ref: '#/components/parameters/IndexName' },
        { $ref: '#/components/parameters/JobId' },
      ],
      post: {
        operationId: 'retryJob',
        summary: 'Retry a terminal failed job',
        responses: {
          '202': {
            description: 'Job returned to the pending queue.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/IndexingJob' } },
            },
          },
          '404': { description: 'Job not found.' },
        },
      },
    },
    '/v1/indexes/{index}/status': {
      parameters: [{ $ref: '#/components/parameters/IndexName' }],
      get: {
        operationId: 'getIndexStatus',
        summary: 'Inspect index generation and job health',
        responses: {
          '200': {
            description: 'Index status.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/IndexStatus' } },
            },
          },
          '404': { description: 'Index not found.' },
        },
      },
    },
  },
  components: {
    parameters: {
      IndexName: {
        name: 'index',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
      },
      DocumentId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' },
      },
      JobId: {
        name: 'jobId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    schemas: {
      IndexConfig: {
        type: 'object',
        required: ['searchableFields'],
        properties: {
          searchableFields: {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
              type: 'object',
              properties: {
                boost: { type: 'number', exclusiveMinimum: 0, maximum: 100, default: 1 },
              },
            },
          },
          storedFields: { type: 'array', items: { type: 'string' } },
          maxTokenLength: { type: 'integer', minimum: 8, maximum: 1024, default: 128 },
          filterableFields: { type: 'array', items: { type: 'string' } },
          maxQueryTerms: { type: 'integer', minimum: 1, maximum: 256, default: 32 },
        },
      },
      CreateIndexRequest: {
        type: 'object',
        required: ['name', 'config'],
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
          config: { $ref: '#/components/schemas/IndexConfig' },
        },
      },
      DocumentRequest: {
        type: 'object',
        required: ['fields'],
        properties: {
          id: { type: 'string' },
          fields: {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
          },
        },
      },
      DocumentResponse: {
        type: 'object',
        required: ['id', 'version', 'fields', 'searchVisible'],
        properties: {
          id: { type: 'string' },
          version: { type: 'integer' },
          fields: { type: 'object' },
          searchVisible: { type: 'boolean' },
          indexVersion: { type: ['integer', 'null'] },
        },
      },
      AsyncDocumentResponse: {
        type: 'object',
        required: ['id', 'version', 'jobId', 'searchVisible'],
        properties: {
          id: { type: 'string' },
          version: { type: 'integer' },
          jobId: { type: 'string', format: 'uuid' },
          searchVisible: { const: false },
        },
      },
      DeleteResponse: {
        type: 'object',
        required: ['id', 'version', 'deleted', 'searchVisible'],
        properties: {
          id: { type: 'string' },
          version: { type: 'integer' },
          deleted: { type: 'boolean' },
          searchVisible: { type: 'boolean' },
          indexVersion: { type: ['integer', 'null'] },
        },
      },
      AsyncDeleteResponse: {
        type: 'object',
        required: ['id', 'version', 'jobId', 'deleted', 'searchVisible'],
        properties: {
          id: { type: 'string' },
          version: { type: 'integer' },
          jobId: { type: 'string', format: 'uuid' },
          deleted: { const: true },
          searchVisible: { const: false },
        },
      },
      BulkItemResult: {
        type: 'object',
        required: ['_id', 'status', 'version', 'jobId', 'deleted', 'searchVisible'],
        properties: {
          _id: { type: 'string' },
          status: { type: 'integer' },
          version: { type: 'integer' },
          jobId: { type: ['string', 'null'], format: 'uuid' },
          deleted: { type: 'boolean' },
          searchVisible: { type: 'boolean' },
          indexVersion: { type: ['integer', 'null'] },
        },
      },
      BulkResponse: {
        type: 'object',
        required: ['errors', 'items', 'tookMs'],
        properties: {
          errors: { const: false },
          items: {
            type: 'array',
            items: {
              type: 'object',
              minProperties: 1,
              maxProperties: 1,
              additionalProperties: { $ref: '#/components/schemas/BulkItemResult' },
            },
          },
          tookMs: { type: 'number' },
        },
      },
      IndexMetadata: {
        type: 'object',
        required: ['name', 'config', 'state', 'activeGeneration', 'createdAt', 'updatedAt'],
        properties: {
          name: { type: 'string' },
          config: { $ref: '#/components/schemas/IndexConfig' },
          state: { type: 'string' },
          activeGeneration: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      SearchResponse: {
        type: 'object',
        required: [
          'hits',
          'totalHits',
          'totalHitsRelation',
          'nextCursor',
          'indexVersion',
          'tookMs',
        ],
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'score', 'document'],
              properties: {
                id: { type: 'string' },
                score: { type: 'number' },
                document: { type: 'object' },
              },
            },
          },
          totalHits: { type: 'integer' },
          totalHitsRelation: { type: 'string', enum: ['eq'] },
          nextCursor: { type: ['string', 'null'] },
          indexVersion: { type: 'integer' },
          tookMs: { type: 'number' },
        },
      },
      IndexingJob: {
        type: 'object',
        required: [
          'jobId',
          'indexName',
          'documentId',
          'documentVersion',
          'operation',
          'status',
          'attempts',
          'availableAt',
          'claimedAt',
          'completedAt',
          'lastError',
          'createdAt',
        ],
        properties: {
          jobId: { type: 'string', format: 'uuid' },
          indexName: { type: 'string' },
          documentId: { type: 'string' },
          documentVersion: { type: 'integer' },
          operation: { type: 'string', enum: ['upsert', 'delete'] },
          status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
          attempts: { type: 'integer' },
          availableAt: { type: 'string', format: 'date-time' },
          claimedAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          lastError: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      IndexStatus: {
        type: 'object',
        required: ['indexName', 'activeGeneration', 'jobs', 'consistency'],
        properties: {
          indexName: { type: 'string' },
          activeGeneration: { type: 'integer' },
          consistency: { type: 'string', enum: ['eventual', 'synchronous'] },
          jobs: {
            type: 'object',
            required: ['pending', 'processing', 'completed', 'failed', 'lastCompletedAt'],
            properties: {
              pending: { type: 'integer' },
              processing: { type: 'integer' },
              completed: { type: 'integer' },
              failed: { type: 'integer' },
              lastCompletedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;
