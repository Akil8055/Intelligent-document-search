# Implementation Status: Intelligent Document Search Engine

## Local environment

- Node.js 24.4.1 and the existing API and web dependencies are installed.
- The project Python environment is Python 3.14.0; FAISS, Sentence Transformers, PyMuPDF, and FastAPI are installed.
- PostgreSQL and the AI service are reachable locally. The configured PostgreSQL schema is available to the integration tests.
- Redis is not listening on the configured local port. The API therefore runs its concurrency-bounded in-process ingestion queue; Redis-backed BullMQ execution still needs validation on a machine with Redis.
- Local `.env` values are required for database access and JWT signing. The file is ignored by Git and no values are included in this status report.

## Milestone 1 — PDF ingestion and retrieval: complete

- PyMuPDF extracts page text with 1-indexed page references.
- The Python service chunks text, creates `all-MiniLM-L6-v2` embeddings, and indexes normalized vectors with FAISS `IndexFlatIP`.
- PostgreSQL stores document metadata, chunks, ownership, and English full-text search vectors.
- Keyword, semantic, and hybrid Reciprocal Rank Fusion retrieval are implemented.
- Re-processing is idempotent for existing chunk indices; PostgreSQL enforces `(document_id, chunk_index)` uniqueness.

## Milestone 2 — Retrieval evaluation: complete

The 32-query labeled benchmark was run against the local application on 2026-10-23. The corpus is the bundled three-page technical sample PDF.

| Mode | Recall@5 | Precision@5 | MRR | nDCG@5 | Median latency |
|---|---:|---:|---:|---:|---:|
| Keyword | 0.4286 | 0.0857 | 0.4286 | 0.4286 | 3.4 ms |
| Semantic | 1.0000 | 0.2429 | 0.8393 | 0.8677 | 19.5 ms |
| Hybrid (RRF) | 1.0000 | 0.2429 | 0.9643 | 0.9608 | 19.7 ms |

Machine-readable results are in `tests/retrieval/results.json`. Cross-encoder comparison results are in `tests/retrieval/reranker-results.json`; the full report is `docs/retrieval-evaluation.md`.

## Milestone 3 — Accounts, ownership, and data integrity: complete

- Passwords use bcrypt; JWT tokens are used for authenticated accounts, and authentication endpoints are rate-limited.
- User document lists, document operations, keyword search, semantic search, and answer citations are scoped to the authenticated user.
- Missing-token development fallback is limited to development mode; the fixed seed account is not created in production.
- Document deletion removes its database record, uploaded file, and FAISS vectors. Failed ingestion can be retried through the queue.
- The security and API integration tests pass as part of the 23-test API suite.

## Milestone 4 — Reranking and grounded answers: implemented, reranking remains optional

- Search can optionally rerank candidates with `cross-encoder/ms-marco-MiniLM-L-6-v2`.
- Answers return source excerpts with document and page citations. They are extractive and do not call a generative model; weak evidence returns an explicit insufficient-evidence answer.
- The answer path removes common instruction-like prefixes from the retrieval query. Document contents remain quoted source data and are not interpreted as instructions.
- The cross-encoder's sigmoid-transformed value is a ranking signal, not a calibrated probability. `ANSWER_MIN_RELEVANCE_SCORE` should be calibrated before production use.
- On the 28 positive benchmark queries, reranking preserved Recall@5 and Precision@5 but reduced MRR from 0.9643 to 0.9286 and nDCG@5 from 0.9608 to 0.9378. Median latency increased from 19.0 ms to 143.9 ms. Keep reranking opt-in until its value is demonstrated on a representative corpus.

## Milestone 5 — Background ingestion: implemented

- BullMQ jobs use Redis when it is available, with three attempts and exponential retry delays.
- When Redis cannot be reached, a bounded in-process worker retries jobs locally. This fallback is not durable across API restarts.
- Job state and per-job attempt counts are stored in PostgreSQL. A retry request returns `202 Accepted` with its queued job id.
- The local queue path is covered by the API integration suite. Redis-backed processing was not exercised because no Redis server is available in the current environment.

## Verification run

- `npm run typecheck` in `apps/api`: passed.
- `npm test` in `apps/api`: 23 tests passed across 4 files.
- `npm run build` in `apps/web`: passed.
- `pytest tests -q` in the project Python environment: 4 tests passed.
- The 32-query retrieval evaluation and 28-query reranker comparison completed and updated the report artifacts.
- The API and web app respond locally at `http://127.0.0.1:3001` and `http://127.0.0.1:5173`; the API health check reports PostgreSQL and AI service healthy.

## Remaining limitations

- OCR is not implemented; image-only/scanned PDFs fail with a clear message.
- The answer generator is extractive. Local or remote LLM synthesis is not included.
- Evaluation uses one small sample document; reranker score thresholds and quality should be validated with a representative private corpus.
- Redis-backed durability needs a local Redis installation and a separate verification run.
