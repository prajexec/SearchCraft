# Security and Trust Boundary

SearchCraft is currently designed for a trusted local deployment. It does not implement authentication, authorization, multitenancy, or distributed rate limiting. A deployment that binds beyond localhost must add those controls before accepting untrusted clients.

## Implemented safeguards

- Strict index and document identifier grammars.
- JSON content-type checks for document and index writes.
- Maximum declared and streamed request-body sizes.
- Maximum query-string length.
- Query result limit from 1 through 100.
- Parameterized SQLite statements.
- No stack traces in normal API error responses.
- Index paths derived from validated names rather than raw URL components.
- Bounded in-memory metric samples.
- Stored-field selection prevents accidental return of unconfigured fields from search hits.

## Data handling

Document content is not logged by the current request logger. Runtime files can contain source documents and postings, so filesystem permissions and backups are deployment responsibilities. Do not place credentials or private payloads in fixtures, logs, benchmark output, or documentation.

## Remaining risks

- There is no authentication or authorization.
- A caller with local filesystem access can read or modify the SQLite database and index files.
- JSON snapshots are not encrypted or signed.
- Expensive search and future maintenance operations need concurrency safeguards.
- The current parser does not expose filters, but future filter syntax must use typed parameter validation rather than SQL fragments.
- Binding to a non-loopback host without a reverse proxy or access control is unsafe.

Security changes that alter the trust boundary require an ADR and API documentation updates.
