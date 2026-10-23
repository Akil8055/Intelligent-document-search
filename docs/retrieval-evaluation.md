# Retrieval Evaluation Report

## Executive Summary
This evaluation measures retrieval performance across three search paradigms:
1. **Keyword-only**: PostgreSQL Full-Text Search with `websearch_to_tsquery` / `plainto_tsquery` and GIN tsvector indexing.
2. **Semantic-only**: Dense vector retrieval using Sentence Transformers (`all-MiniLM-L6-v2`, 384 dimensions) and FAISS inner-product cosine similarity.
3. **Hybrid Search**: Reciprocal Rank Fusion (RRF, $k=60$) blending lexical and semantic candidate streams.

The evaluation suite consists of **32 ground-truth labeled queries** spanning 6 distinct retrieval categories.

---

## Overall Metric Comparison

| Search Mode | Recall@5 | Precision@5 | MRR | nDCG@5 | Latency (Mean) | Latency (p50) | Latency (p95) |
|---|---|---|---|---|---|---|---|
| **Keyword-Only** | 0.4286 | 0.0857 | 0.4286 | 0.4286 | 4.5 ms | 3.4 ms | 5.2 ms |
| **Semantic-Only** | 1.0000 | 0.2429 | 0.8393 | 0.8677 | 20.0 ms | 19.4 ms | 23.8 ms |
| **Hybrid (RRF)** | **1.0000** | **0.2429** | **0.9643** | **0.9608** | 25.1 ms | 19.7 ms | 26.3 ms |

---

## Category-Level Breakdown (MRR & Recall@5)

| Query Category | Queries | Keyword MRR | Semantic MRR | Hybrid MRR | Keyword Recall@5 | Semantic Recall@5 | Hybrid Recall@5 |
|---|---|---|---|---|---|---|---|
| **Exact Keywords** | 6 | 1.0000 | 0.7222 | **1.0000** | 1.0000 | 1.0000 | **1.0000** |
| **Synonyms & Paraphrases** | 6 | 0.0000 | 0.9167 | **0.9167** | 0.0000 | 1.0000 | **1.0000** |
| **Natural Language Questions** | 6 | 0.1667 | 1.0000 | **1.0000** | 0.1667 | 1.0000 | **1.0000** |
| **Rare Identifiers & Codes** | 5 | 1.0000 | 0.6333 | **1.0000** | 1.0000 | 1.0000 | **1.0000** |
| **Multi-Passage / Complex** | 5 | 0.0000 | 0.9000 | **0.9000** | 0.0000 | 1.0000 | **1.0000** |

---

## Key Observations and Empirical Findings

1. **Why Hybrid Search Wins**:
   - **Exact Identifiers & Rare Codes**: Keyword search achieves higher MRR on technical acronyms and SKU codes (`BM25`, `TF-IDF`, `ms-marco-MiniLM-L-6-v2`) where dense embeddings often experience semantic drift.
   - **Synonyms & Conceptual Inquiries**: Semantic search significantly outperforms keyword search on paraphrased queries (e.g., *"splitting documents into smaller sections with overlap"*), where lexical tokens do not match verbatim.
   - **Reciprocal Rank Fusion**: By taking candidates from both retrieval models, RRF achieves the highest overall **Recall@5 (1.0000)** and **MRR (0.9643)**, providing a resilient safety net regardless of user query phrasing.

2. **Negative Query Behavior**:
   - Out of 4 negative queries with zero ground-truth relevance, both keyword and semantic searches returned 0 relevant matches.
   - Grounded answers use the cross-encoder ranking signal to reject weak matches, but the sigmoid-transformed score is not a calibrated probability.

3. **Latency Profile**:
   - Keyword search executes in ~4.5 ms using PostgreSQL GIN indexes.
   - Semantic search executes in ~20.0 ms (dominated by Sentence Transformer embedding inference).
   - Hybrid search executes both branches concurrently, yielding a p50 latency of **19.7 ms**, which is well within production interactive search thresholds (< 150 ms).

*Note: This benchmark evaluates 32 queries on a multi-page technical corpus. For production scaling to millions of documents, see Milestone 5 for load benchmarking.*

## Milestone 4: Cross-Encoder Reranking Impact Analysis

Comparing initial **Hybrid Retrieval** with **Hybrid + Cross-Encoder Reranking** (`cross-encoder/ms-marco-MiniLM-L-6-v2`):

| Configuration | Recall@5 | Precision@5 | MRR | nDCG@5 | Latency (Mean) | Latency (p50) | Latency (p95) |
|---|---|---|---|---|---|---|---|
| **Hybrid (Base)** | 1.0000 | 0.2429 | 0.9643 | 0.9608 | 19.4 ms | 19.0 ms | 24.2 ms |
| **Hybrid + Rerank** | **1.0000** | **0.2429** | **0.9286** | **0.9378** | 150.9 ms | 143.9 ms | 183.7 ms |

### Key Takeaway on Reranking:
- The Cross-Encoder computes full cross-attention over `(query, passage)` pairs and refines ranking positions. Its sigmoid-transformed output is a ranking signal, not a calibrated probability.
- On this 28-query sample, reranking changed MRR from 0.9643 to 0.9286, nDCG@5 from 0.9608 to 0.9378, and median latency from 19.0 ms to 143.9 ms. Keep reranking optional and validate it on a representative corpus before enabling it by default.
