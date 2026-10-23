import os
from pathlib import Path
import pymupdf

def generate_sample_pdf():
    output_dir = Path(__file__).resolve().parent
    output_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = output_dir / "sample_ai_paper.pdf"

    doc = pymupdf.open()

    # Page 1: Abstract & Introduction
    page1 = doc.new_page()
    page1.insert_text(
        (50, 70),
        "Intelligent Document Search: Architecture and Hybrid Retrieval\n"
        "Authors: Antigravity AI Engineering Team\n\n"
        "Abstract:\n"
        "Modern enterprise retrieval systems require balanced precision and recall across complex corporate\n"
        "corpora. This paper explores a hybrid document search engine combining PostgreSQL lexical full-text\n"
        "search with FAISS vector similarity indexing based on dense embeddings from sentence-transformers.\n\n"
        "1. Introduction:\n"
        "Information retrieval (IR) has transitioned from purely keyword-matching paradigms (e.g. BM25 and\n"
        "TF-IDF) to dense semantic vector representations. However, dense vectors frequently struggle with\n"
        "exact technical identifiers, acronyms, and rare SKU codes. Conversely, keyword search fails when users\n"
        "express information needs using synonyms or conceptual paraphrasing.\n"
        "To achieve robust retrieval across varied query intents, we implement Reciprocal Rank Fusion (RRF)\n"
        "to interleave lexical and dense ranking streams.\n",
        fontsize=11
    )

    # Page 2: System Architecture & Ingestion
    page2 = doc.new_page()
    page2.insert_text(
        (50, 70),
        "2. System Architecture and Ingestion Pipeline:\n\n"
        "The application architecture consists of a Node.js/Express orchestration gateway and a high-performance\n"
        "Python FastAPI intelligence service. When a user uploads a PDF file:\n"
        "1. Ingestion: The file is received by the upload handler, validated for MIME type and size, and saved.\n"
        "2. Text Extraction: PyMuPDF parses document trees page by page, tracking 1-indexed page coordinates.\n"
        "3. Chunking: Text is segmented into chunks of approximately 500 tokens with 75 tokens of boundary overlap.\n"
        "4. Embedding Generation: The all-MiniLM-L6-v2 transformer computes 384-dimensional unit-normalized vectors.\n"
        "5. Storage: Chunks are stored in PostgreSQL with tsvector gin indexes, while vectors are indexed in FAISS.\n"
        "6. Idempotency: Unique constraints on (document_id, chunk_index) guarantee deterministic and retry-safe jobs.\n",
        fontsize=11
    )

    # Page 3: Evaluation Metrics & Results
    page3 = doc.new_page()
    page3.insert_text(
        (50, 70),
        "3. Retrieval Evaluation and Empirical Results:\n\n"
        "We evaluate retrieval quality across three core dimensions:\n"
        "- Recall@5: The proportion of ground-truth relevant passages present in the top-5 candidates.\n"
        "- Precision@5: The proportion of retrieved top-5 passages that are truly relevant.\n"
        "- Mean Reciprocal Rank (MRR): Evaluates the reciprocal rank of the first relevant passage.\n"
        "- Normalized Discounted Cumulative Gain (nDCG@5): Evaluates graded relevance ranking.\n\n"
        "Empirical benchmarks demonstrate that hybrid search achieves an MRR of 0.88, significantly outperforming\n"
        "pure keyword search (MRR 0.64) and pure semantic search (MRR 0.76) on mixed corporate queries.\n"
        "Furthermore, cross-encoder reranking using ms-marco-MiniLM-L-6-v2 refines top candidates,\n"
        "eliminating semantic drift and improving Precision@1 to 91%.\n",
        fontsize=11
    )

    doc.save(str(pdf_path))
    doc.close()
    print(f"Created sample PDF at: {pdf_path}")

if __name__ == "__main__":
    generate_sample_pdf()
