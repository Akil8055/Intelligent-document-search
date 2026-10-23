import os
import sys
import tempfile
import pytest
import numpy as np
import pymupdf

# Ensure services/ai is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "services", "ai")))

from extractor import PDFExtractor, PDFExtractionError
from chunker import DocumentChunker
from vector_store import FaissVectorStore

def create_sample_pdf(file_path: str, pages_text: list):
    """Helper to create a multi-page PDF for testing."""
    doc = pymupdf.open()
    for text in pages_text:
        page = doc.new_page()
        page.insert_text((50, 72), text)
    doc.save(file_path)
    doc.close()

def test_pdf_extractor():
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        pdf_path = f.name

    try:
        pages_content = [
            "This is page one of our document search test. It contains information about PostgreSQL full-text search.",
            "This is page two. It discusses FAISS vector similarity and Sentence Transformers embeddings.",
            "This is page three. It covers hybrid search with Reciprocal Rank Fusion."
        ]
        create_sample_pdf(pdf_path, pages_content)

        extracted = PDFExtractor.extract_from_file(pdf_path)
        assert extracted["page_count"] == 3
        assert extracted["is_scanned"] is False
        assert len(extracted["pages"]) == 3
        assert extracted["pages"][0]["page_number"] == 1
        assert "PostgreSQL" in extracted["pages"][0]["text"]
        assert extracted["pages"][1]["page_number"] == 2
        assert "FAISS" in extracted["pages"][1]["text"]
        assert extracted["pages"][2]["page_number"] == 3
        assert "Reciprocal Rank Fusion" in extracted["pages"][2]["text"]
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)

def test_scanned_pdf_detection():
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        pdf_path = f.name

    try:
        # Create a PDF with empty pages (like a scanned document without OCR text)
        doc = pymupdf.open()
        doc.new_page()
        doc.save(pdf_path)
        doc.close()

        extracted = PDFExtractor.extract_from_file(pdf_path)
        assert extracted["is_scanned"] is True
        assert "OCR" in extracted["status_message"]
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)

def test_document_chunker():
    chunker = DocumentChunker(chunk_size=15, chunk_overlap=5)
    pages = [
        {
            "page_number": 1,
            "text": "Antigravity is building an intelligent document search engine. It processes PDFs with PyMuPDF. Chunking preserves source page references."
        },
        {
            "page_number": 2,
            "text": "Vector retrieval uses FAISS with inner-product indexing. Hybrid search fuses keyword and semantic rankings."
        }
    ]

    chunks = chunker.chunk_pages(pages, document_id="doc-123")
    assert len(chunks) >= 2
    for chunk in chunks:
        assert chunk["document_id"] == "doc-123"
        assert chunk["page_number"] in [1, 2]
        assert len(chunk["content"]) > 0
        assert chunk["chunk_index"] >= 0

def test_faiss_vector_store():
    with tempfile.TemporaryDirectory() as temp_dir:
        index_path = os.path.join(temp_dir, "test_faiss.bin")
        meta_path = os.path.join(temp_dir, "test_meta.json")

        store = FaissVectorStore(dimension=4, index_path=index_path, metadata_path=meta_path)
        assert store.count() == 0

        # Create 3 vectors
        chunk_ids = ["chunk-1", "chunk-2", "chunk-3"]
        doc_ids = ["doc-A", "doc-A", "doc-B"]
        # chunk-1 and chunk-2 close together, chunk-3 orthogonal
        vectors = np.array([
            [1.0, 0.0, 0.0, 0.0],
            [0.9, 0.1, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0]
        ], dtype=np.float32)

        store.add_vectors(chunk_ids, vectors, doc_ids)
        assert store.count() == 3

        # Search query close to vector 1
        query = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
        results = store.search(query, top_k=2)
        assert len(results) == 2
        assert results[0]["chunk_id"] == "chunk-1"
        assert results[0]["score"] > 0.99
        assert results[1]["chunk_id"] == "chunk-2"

        # Test authorization filter (allowed_chunk_ids)
        restricted_results = store.search(query, top_k=2, allowed_chunk_ids=["chunk-3"])
        assert len(restricted_results) == 1
        assert restricted_results[0]["chunk_id"] == "chunk-3"

        # Test document deletion
        deleted = store.delete_document("doc-A")
        assert deleted == 2
        assert store.count() == 1

        # Test index persistence and reload
        store_reloaded = FaissVectorStore(dimension=4, index_path=index_path, metadata_path=meta_path)
        assert store_reloaded.count() == 1
        results_after_reload = store_reloaded.search(query, top_k=5)
        assert len(results_after_reload) == 1
        assert results_after_reload[0]["chunk_id"] == "chunk-3"

def test_faiss_reconcile_removes_vectors_without_database_chunks():
    with tempfile.TemporaryDirectory() as temp_dir:
        store = FaissVectorStore(
            dimension=2,
            index_path=os.path.join(temp_dir, "reconcile.bin"),
            metadata_path=os.path.join(temp_dir, "reconcile.json"),
        )
        vectors = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        store.add_vectors(["valid", "orphan"], vectors, ["doc-A", "deleted-doc"])

        removed = store.reconcile_chunks(["valid"])

        assert removed == 1
        assert store.count() == 1
        assert [match["chunk_id"] for match in store.search(np.array([1.0, 0.0]), top_k=5)] == ["valid"]
