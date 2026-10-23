# Intelligent Document Search Engine

A local PDF search application with a React and TypeScript web client, an Express API, PostgreSQL full-text search, and a FastAPI service that extracts PDFs, creates Sentence Transformer embeddings, and indexes them in FAISS. The API supports keyword, semantic, and hybrid retrieval, optional cross-encoder reranking, extractive answers with page citations, user accounts, and queued ingestion.

## Requirements

- Node.js 20 or newer
- Python 3.10 or newer
- PostgreSQL 18, with a local `docsearch` database
- Redis for durable BullMQ jobs (the API uses a bounded in-process queue when Redis is unavailable)

PostgreSQL stores users, documents, chunks, ingestion records, and full-text indexes. FAISS stores vectors in `services/ai/data/`. No Docker, Compose, or pgvector extension is used.

## Local setup

1. Create a local `.env` from `.env.example` if one does not already exist. Set a private PostgreSQL connection string and a random `JWT_SECRET` of at least 32 characters. Keep `.env` private; it is ignored by Git. No database password needs to be shared in chat.
2. Create the PostgreSQL database named `docsearch`, then apply the schema:

   ```powershell
   python database/migrate.py
   ```

3. Install the existing Node dependencies and Python requirements:

   ```powershell
   npm ci --prefix apps/api
   npm ci --prefix apps/web
   python -m venv services/ai/.venv
   services/ai/.venv/Scripts/python.exe -m pip install -r services/ai/requirements.txt
   ```

4. Start the AI service from the repository root:

   ```powershell
   services/ai/.venv/Scripts/python.exe -m uvicorn main:app --app-dir services/ai --host 127.0.0.1 --port 8000
   ```

5. In another terminal, start the API and web app:

   ```powershell
   npm run dev --prefix apps/api
   npm run dev --prefix apps/web
   ```

6. Open `http://127.0.0.1:5173`. The API health check is at `http://127.0.0.1:3000/health` and the AI service health check is at `http://127.0.0.1:8000/health`.

Redis is read from `REDIS_URL`. When Redis is running, BullMQ persists and retries ingestion jobs. Without Redis, a bounded in-process worker keeps local development usable; queued jobs in that fallback are not durable across API restarts.

The first model-backed request downloads the configured Sentence Transformers and cross-encoder models if they are not cached. Model downloads require network access.

## Checks

```powershell
npm run typecheck --prefix apps/api
npm run test --prefix apps/api
npm run build --prefix apps/web
services/ai/.venv/Scripts/python.exe -m pytest tests -q
```

The API integration tests need PostgreSQL, the migrated `docsearch` database, and the AI service. Tests that exercise BullMQ also need Redis to check the durable queue provider; without Redis the queue unit coverage can still use the local fallback.

## Search and answer behavior

- Keyword search uses PostgreSQL's English full-text search.
- Semantic search uses normalized `all-MiniLM-L6-v2` embeddings and exact FAISS inner-product cosine similarity.
- Hybrid search combines both candidate lists with reciprocal rank fusion.
- Reranking uses `cross-encoder/ms-marco-MiniLM-L-6-v2` when requested.
- Answers are extractive: returned passages remain verbatim evidence with document and page citations. No external language model is called. The displayed reranker score is a ranking signal, not a calibrated probability; tune `ANSWER_MIN_RELEVANCE_SCORE` against a representative corpus before treating it as a reliable answer threshold.

See [docs/retrieval-evaluation.md](docs/retrieval-evaluation.md) for the current labeled-query evaluation and [docs/implementation-status.md](docs/implementation-status.md) for milestone notes.
