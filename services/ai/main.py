from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Body, Query
from pydantic import BaseModel, Field
import numpy as np

from config import settings
from extractor import PDFExtractor, PDFExtractionError, ScannedPDFError
from chunker import DocumentChunker
from embedding import EmbeddingEngine
from vector_store import FaissVectorStore
from reranker import RerankerEngine

# Global state objects
embedding_engine: Optional[EmbeddingEngine] = None
vector_store: Optional[FaissVectorStore] = None
reranker_engine: Optional[RerankerEngine] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global embedding_engine, vector_store, reranker_engine
    print("Initializing AI Service resources...")
    embedding_engine = EmbeddingEngine(settings.EMBEDDING_MODEL)
    vector_store = FaissVectorStore(
        dimension=384,
        index_path=settings.FAISS_INDEX_PATH,
        metadata_path=settings.FAISS_METADATA_PATH
    )
    reranker_engine = RerankerEngine(settings.RERANKER_MODEL)
    print(f"AI Service ready. Indexed vectors in FAISS: {vector_store.count()}")
    yield
    print("Shutting down AI Service...")
    if vector_store:
        vector_store.save()

app = FastAPI(title="Document Intelligence AI Service", version="1.0.0", lifespan=lifespan)

# Pydantic Request Models
class ExtractRequest(BaseModel):
    file_path: str

class ChunkRequest(BaseModel):
    document_id: str
    pages: List[Dict[str, Any]]
    chunk_size: Optional[int] = settings.DEFAULT_CHUNK_SIZE
    chunk_overlap: Optional[int] = settings.DEFAULT_CHUNK_OVERLAP

class EmbedRequest(BaseModel):
    texts: List[str]

class IndexChunkItem(BaseModel):
    chunk_id: str
    document_id: str
    content: str
    embedding: Optional[List[float]] = None

class IndexRequest(BaseModel):
    chunks: List[IndexChunkItem]

class ReconcileIndexRequest(BaseModel):
    valid_chunk_ids: List[str]

class SearchRequest(BaseModel):
    query: str
    top_k: int = Field(default=10, ge=1, le=100)
    allowed_chunk_ids: Optional[List[str]] = None

class RerankRequest(BaseModel):
    query: str
    passages: List[str]
    top_k: Optional[int] = 5

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "ai-retrieval",
        "embedding_model": settings.EMBEDDING_MODEL,
        "reranker_model": settings.RERANKER_MODEL,
        "vector_count": vector_store.count() if vector_store else 0
    }

@app.post("/extract")
def extract_pdf(req: ExtractRequest):
    try:
        requested_path = Path(req.file_path).resolve()
        upload_root = Path(settings.UPLOAD_DIR)
        if not upload_root.is_absolute():
            upload_root = Path(__file__).resolve().parents[2] / upload_root
        upload_root = upload_root.resolve()
        if not requested_path.is_relative_to(upload_root):
            raise HTTPException(status_code=400, detail="PDF path must be inside the configured upload directory")
        result = PDFExtractor.extract_from_file(req.file_path)
        return result
    except HTTPException:
        raise
    except PDFExtractionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected extraction error: {str(e)}")

@app.post("/chunk")
def chunk_document(req: ChunkRequest):
    try:
        chunker = DocumentChunker(
            chunk_size=req.chunk_size or settings.DEFAULT_CHUNK_SIZE,
            chunk_overlap=req.chunk_overlap or settings.DEFAULT_CHUNK_OVERLAP,
            embedding_model=settings.EMBEDDING_MODEL
        )
        chunks = chunker.chunk_pages(req.pages, document_id=req.document_id)
        return {"document_id": req.document_id, "chunk_count": len(chunks), "chunks": chunks}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Chunking error: {str(e)}")

@app.post("/embed")
def embed_texts(req: EmbedRequest):
    if not embedding_engine:
        raise HTTPException(status_code=503, detail="Embedding engine not initialized")
    embeddings = embedding_engine.encode(req.texts)
    return {"count": len(req.texts), "dimension": embeddings.shape[1], "embeddings": embeddings.tolist()}

@app.post("/index")
def index_chunks(req: IndexRequest):
    if not vector_store or not embedding_engine:
        raise HTTPException(status_code=503, detail="Services not initialized")

    if not req.chunks:
        return {"indexed_count": 0, "total_indexed": vector_store.count()}

    chunk_ids = [c.chunk_id for c in req.chunks]
    doc_ids = [c.document_id for c in req.chunks]

    # Check if any chunk needs embedding generation
    missing_idx = [i for i, c in enumerate(req.chunks) if c.embedding is None]
    if missing_idx:
        texts_to_embed = [req.chunks[i].content for i in missing_idx]
        generated_embeddings = embedding_engine.encode(texts_to_embed)
        for local_idx, orig_idx in enumerate(missing_idx):
            req.chunks[orig_idx].embedding = generated_embeddings[local_idx].tolist()

    embeddings_matrix = np.array([c.embedding for c in req.chunks], dtype=np.float32)
    vector_store.add_vectors(chunk_ids=chunk_ids, embeddings=embeddings_matrix, doc_ids=doc_ids)

    return {
        "indexed_count": len(req.chunks),
        "total_indexed": vector_store.count()
    }

@app.post("/index/reconcile")
def reconcile_index(req: ReconcileIndexRequest):
    if not vector_store:
        raise HTTPException(status_code=503, detail="Vector store not initialized")

    removed = vector_store.reconcile_chunks(req.valid_chunk_ids)
    return {"removed_count": removed, "total_indexed": vector_store.count()}

@app.post("/search")
def search_vectors(req: SearchRequest):
    if not vector_store or not embedding_engine:
        raise HTTPException(status_code=503, detail="Services not initialized")

    query_vec = embedding_engine.encode_query(req.query)
    matches = vector_store.search(
        query_vector=query_vec,
        top_k=req.top_k,
        allowed_chunk_ids=req.allowed_chunk_ids
    )

    return {
        "query": req.query,
        "results_count": len(matches),
        "matches": matches
    }

@app.post("/rerank")
def rerank_passages(req: RerankRequest):
    if not reranker_engine:
        raise HTTPException(status_code=503, detail="Reranker engine not initialized")

    top_k = req.top_k or 5
    ranked = reranker_engine.rerank(query=req.query, passages=req.passages, top_k=top_k)
    return {
        "query": req.query,
        "reranked_count": len(ranked),
        "results": ranked
    }

@app.delete("/index/document/{document_id}")
def delete_document_vectors(document_id: str):
    if not vector_store:
        raise HTTPException(status_code=503, detail="Vector store not initialized")

    deleted = vector_store.delete_document(document_id)
    return {
        "document_id": document_id,
        "deleted_count": deleted,
        "total_indexed": vector_store.count()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=False)
