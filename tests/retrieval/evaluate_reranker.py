import os
import json
import time
from pathlib import Path
import httpx
import numpy as np
from evaluate import compute_dcg, compute_ndcg, ensure_document_indexed, DATASET_PATH, API_URL, REPORT_PATH

RERANKER_RESULTS_PATH = Path(__file__).resolve().parent / "reranker-results.json"

def evaluate_reranker():
    with open(DATASET_PATH, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    client = httpx.Client(timeout=30.0)
    doc_id = ensure_document_indexed(client)

    modes = [("hybrid", False), ("hybrid + rerank", True)]
    results = {}

    for mode_name, use_rerank in modes:
        print(f"\nEvaluating: {mode_name.upper()}...")
        recalls, precisions, mrrs, ndcgs, latencies = [], [], [], [], []

        for item in dataset:
            cat = item["category"]
            if cat == "negative":
                continue  # Evaluate positive retrieval ranking

            expected_pages = set(item.get("relevant_pages", []))
            keywords = [kw.lower() for kw in item.get("relevant_keywords", [])]
            graded = {str(k): float(v) for k, v in item.get("graded_relevance", {}).items()}

            start_t = time.perf_counter()
            resp = client.post(
                f"{API_URL}/search",
                json={
                    "query": item["query"],
                    "mode": "hybrid",
                    "top_k": 5,
                    "document_ids": [doc_id],
                    "rerank": use_rerank
                }
            )
            elapsed_ms = (time.perf_counter() - start_t) * 1000.0
            latencies.append(elapsed_ms)

            if resp.status_code != 200:
                raise RuntimeError(f"Search failed for query {item['id']}: {resp.status_code} {resp.text}")

            items = resp.json().get("results", [])
            retrieved_pages = set()
            relevance_flags = []
            relevance_scores = []

            for r in items:
                page = r.get("page_number", 0)
                content = r.get("content", "").lower()
                is_rel = (page in expected_pages) and (any(kw in content for kw in keywords) if keywords else True)
                relevance_flags.append(is_rel)
                if is_rel:
                    retrieved_pages.add(page)
                    relevance_scores.append(graded.get(str(page), 1.0))
                else:
                    relevance_scores.append(0.0)

            recalls.append(len(retrieved_pages) / len(expected_pages) if expected_pages else 0.0)
            precisions.append(sum(1 for f in relevance_flags if f) / 5.0)

            first_rank = 0
            for i, f in enumerate(relevance_flags):
                if f:
                    first_rank = i + 1
                    break
            mrrs.append(1.0 / first_rank if first_rank > 0 else 0.0)
            ndcgs.append(compute_ndcg(relevance_scores, list(graded.values()), k=5))

        results[mode_name] = {
            "recall@5": round(float(np.mean(recalls)), 4),
            "precision@5": round(float(np.mean(precisions)), 4),
            "mrr": round(float(np.mean(mrrs)), 4),
            "ndcg@5": round(float(np.mean(ndcgs)), 4),
            "latency_p50": round(float(np.percentile(latencies, 50)), 2),
            "latency_p95": round(float(np.percentile(latencies, 95)), 2),
            "latency_mean": round(float(np.mean(latencies)), 2),
        }
        print(f"Results for {mode_name.upper()}:")
        print(f"  Recall@5:     {results[mode_name]['recall@5']}")
        print(f"  Precision@5:  {results[mode_name]['precision@5']}")
        print(f"  MRR:          {results[mode_name]['mrr']}")
        print(f"  nDCG@5:       {results[mode_name]['ndcg@5']}")
        print(f"  Latency p50:  {results[mode_name]['latency_p50']} ms")

    # Append comparison to docs/retrieval-evaluation.md
    report = REPORT_PATH.read_text(encoding="utf-8") if REPORT_PATH.exists() else ""
    section_title = "## Milestone 4: Cross-Encoder Reranking Impact Analysis"
    report = report.split(section_title, maxsplit=1)[0].rstrip()
    RERANKER_RESULTS_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")
    report += f"""

{section_title}

Comparing initial **Hybrid Retrieval** with **Hybrid + Cross-Encoder Reranking** (`cross-encoder/ms-marco-MiniLM-L-6-v2`):

| Configuration | Recall@5 | Precision@5 | MRR | nDCG@5 | Latency (Mean) | Latency (p50) | Latency (p95) |
|---|---|---|---|---|---|---|---|
| **Hybrid (Base)** | {results['hybrid']['recall@5']:.4f} | {results['hybrid']['precision@5']:.4f} | {results['hybrid']['mrr']:.4f} | {results['hybrid']['ndcg@5']:.4f} | {results['hybrid']['latency_mean']:.1f} ms | {results['hybrid']['latency_p50']:.1f} ms | {results['hybrid']['latency_p95']:.1f} ms |
| **Hybrid + Rerank** | **{results['hybrid + rerank']['recall@5']:.4f}** | **{results['hybrid + rerank']['precision@5']:.4f}** | **{results['hybrid + rerank']['mrr']:.4f}** | **{results['hybrid + rerank']['ndcg@5']:.4f}** | {results['hybrid + rerank']['latency_mean']:.1f} ms | {results['hybrid + rerank']['latency_p50']:.1f} ms | {results['hybrid + rerank']['latency_p95']:.1f} ms |

### Key Takeaway on Reranking:
- The Cross-Encoder computes full cross-attention over `(query, passage)` pairs and refines ranking positions. Its sigmoid-transformed output is a ranking signal, not a calibrated probability.
- On this 28-query sample, reranking changed MRR from {results['hybrid']['mrr']:.4f} to {results['hybrid + rerank']['mrr']:.4f}, nDCG@5 from {results['hybrid']['ndcg@5']:.4f} to {results['hybrid + rerank']['ndcg@5']:.4f}, and median latency from {results['hybrid']['latency_p50']:.1f} ms to {results['hybrid + rerank']['latency_p50']:.1f} ms. Keep reranking optional and validate it on a representative corpus before enabling it by default.
"""
    REPORT_PATH.write_text(report, encoding="utf-8")
    print("\nSuccessfully updated docs/retrieval-evaluation.md with reranking analysis!")

if __name__ == "__main__":
    evaluate_reranker()
