export const openapiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'SearchCraft API',
    version: '0.1.0',
    description:
      'A lightweight, local-first search indexing and query service. The foundation currently exposes operational endpoints; search endpoints are added as their underlying functionality becomes available.',
  },
  servers: [{ url: 'http://127.0.0.1:3000' }],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Report process health',
        responses: {
          '200': {
            description: 'The process is running.',
          },
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
  },
} as const;
