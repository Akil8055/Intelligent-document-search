import os
import json
import threading
from abc import ABC, abstractmethod
from typing import List, Dict, Tuple, Optional, Any
import numpy as np
import faiss
from config import settings

class BaseVectorStore(ABC):
    """Abstract interface for vector store backends."""

    @abstractmethod
    def add_vectors(self, chunk_ids: List[str], embeddings: np.ndarray, doc_ids: List[str]) -> None:
        pass

    @abstractmethod
    def search(
        self,
        query_vector: np.ndarray,
        top_k: int = 10,
        allowed_chunk_ids: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def delete_document(self, document_id: str) -> int:
        pass

    @abstractmethod
    def delete_chunks(self, chunk_ids: List[str]) -> int:
        """Delete specific chunks by IDs."""
        pass

    @abstractmethod
    def reconcile_chunks(self, valid_chunk_ids: List[str]) -> int:
        """Remove any stored chunks whose IDs are not in the whitelist.
        Returns the number of chunks removed.
        """
        pass

    @abstractmethod
    def save(self) -> None:
        pass

    @abstractmethod
    def load(self) -> None:
        pass

    @abstractmethod
    def count(self) -> int:
        pass

class FaissVectorStore(BaseVectorStore):
    """
    FAISS-based vector index implementation using IndexFlatIP for exact cosine similarity.
    Maintains persistent mapping between FAISS vector positions and PostgreSQL chunk IDs.
    """

    def __init__(
        self,
        dimension: int = 384,
        index_path: str = settings.FAISS_INDEX_PATH,
        metadata_path: str = settings.FAISS_METADATA_PATH
    ):
        self.dimension = dimension
        self.index_path = index_path
        self.metadata_path = metadata_path
        self._lock = threading.Lock()

        # In-memory mapping data structures
        # chunk_id -> { "doc_id": str, "embedding": np.ndarray }
        self._chunks: Dict[str, Dict[str, Any]] = {}
        # Order of chunks in the FAISS index
        self._chunk_ids: List[str] = []
        self._index: faiss.IndexFlatIP = faiss.IndexFlatIP(self.dimension)

        # Ensure directory exists
        os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
        # Attempt to load existing index from disk if present
        self.load()

    def count(self) -> int:
        with self._lock:
            return self._index.ntotal

    def _rebuild_index_locked(self) -> None:
        """Internal helper to rebuild FAISS index from current chunks dictionary."""
        new_index = faiss.IndexFlatIP(self.dimension)
        chunk_ids = list(self._chunks.keys())
        if chunk_ids:
            matrix = np.vstack([self._chunks[cid]["embedding"] for cid in chunk_ids]).astype(np.float32)
            # Normalize just to be 100% sure unit length is preserved
            faiss.normalize_L2(matrix)
            new_index.add(matrix)
        self._chunk_ids = chunk_ids
        self._index = new_index

    def add_vectors(self, chunk_ids: List[str], embeddings: np.ndarray, doc_ids: List[str]) -> None:
        """
        Add or update vectors in the index and persist to storage.
        """
        if len(chunk_ids) == 0:
            return

        with self._lock:
            embeddings = embeddings.astype(np.float32)
            if embeddings.ndim == 1:
                embeddings = np.expand_dims(embeddings, axis=0)

            # Ensure unit normalization for cosine similarity
            faiss.normalize_L2(embeddings)

            for i, chunk_id in enumerate(chunk_ids):
                doc_id = doc_ids[i] if i < len(doc_ids) else ""
                self._chunks[chunk_id] = {
                    "doc_id": doc_id,
                    "embedding": embeddings[i].copy()
                }

            self._rebuild_index_locked()
            self._save_locked()

    def search(
        self,
        query_vector: np.ndarray,
        top_k: int = 10,
        allowed_chunk_ids: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        Cosine similarity search over normalized embeddings.
        Supports filtering by allowed_chunk_ids for user authorization / isolation.
        """
        with self._lock:
            if self._index.ntotal == 0:
                return []

            q_vec = query_vector.astype(np.float32)
            if q_vec.ndim == 1:
                q_vec = np.expand_dims(q_vec, axis=0)
            faiss.normalize_L2(q_vec)

            # If filtering by allowed_chunk_ids, we need to inspect more candidates
            search_k = min(self._index.ntotal, max(top_k * 4, 50) if allowed_chunk_ids else top_k)
            distances, indices = self._index.search(q_vec, search_k)

            allowed_set = set(allowed_chunk_ids) if allowed_chunk_ids is not None else None
            results: List[Dict[str, Any]] = []

            for score, idx in zip(distances[0], indices[0]):
                if idx < 0 or idx >= len(self._chunk_ids):
                    continue

                chunk_id = self._chunk_ids[idx]
                if allowed_set is not None and chunk_id not in allowed_set:
                    continue

                doc_id = self._chunks[chunk_id]["doc_id"]
                results.append({
                    "chunk_id": chunk_id,
                    "document_id": doc_id,
                    "score": float(score)  # Cosine similarity in range [-1.0, 1.0]
                })

                if len(results) >= top_k:
                    break

            return results

    def delete_document(self, document_id: str) -> int:
        """
        Delete all chunks and vectors belonging to a specific document.
        """
        with self._lock:
            to_remove = [cid for cid, data in self._chunks.items() if data["doc_id"] == document_id]
            for cid in to_remove:
                del self._chunks[cid]

            if to_remove:
                self._rebuild_index_locked()
                self._save_locked()

            return len(to_remove)

    def delete_chunks(self, chunk_ids: List[str]) -> int:
        """
        Delete specific chunks by ID.
        """
        with self._lock:
            removed = 0
            for cid in chunk_ids:
                if cid in self._chunks:
                    del self._chunks[cid]
                    removed += 1

            if removed > 0:
                self._rebuild_index_locked()
                self._save_locked()

            return removed

    def reconcile_chunks(self, valid_chunk_ids: List[str]) -> int:
        """Remove vectors whose authoritative PostgreSQL chunks no longer exist."""
        valid_ids = set(valid_chunk_ids)
        with self._lock:
            stale_ids = [chunk_id for chunk_id in self._chunks if chunk_id not in valid_ids]
            for chunk_id in stale_ids:
                del self._chunks[chunk_id]

            if stale_ids:
                self._rebuild_index_locked()
                self._save_locked()

            return len(stale_ids)

    def _save_locked(self) -> None:
        """Persist index and metadata to disk."""
        faiss.write_index(self._index, self.index_path)
        # Store metadata mapping and vectors as JSON/np arrays
        metadata = {
            "chunk_ids": self._chunk_ids,
            "docs": {cid: self._chunks[cid]["doc_id"] for cid in self._chunk_ids},
            "embeddings": {cid: self._chunks[cid]["embedding"].tolist() for cid in self._chunk_ids}
        }
        with open(self.metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f)

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    def load(self) -> None:
        with self._lock:
            if not os.path.exists(self.index_path) or not os.path.exists(self.metadata_path):
                self._index = faiss.IndexFlatIP(self.dimension)
                self._chunks = {}
                self._chunk_ids = []
                return

            try:
                self._index = faiss.read_index(self.index_path)
                with open(self.metadata_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)

                self._chunks = {}
                self._chunk_ids = meta.get("chunk_ids", [])
                docs = meta.get("docs", {})
                embs = meta.get("embeddings", {})

                for cid in self._chunk_ids:
                    if cid in embs:
                        self._chunks[cid] = {
                            "doc_id": docs.get(cid, ""),
                            "embedding": np.array(embs[cid], dtype=np.float32)
                        }

                # Ensure index matches chunks
                if self._index.ntotal != len(self._chunks):
                    self._rebuild_index_locked()
            except Exception as e:
                print(f"Warning: Could not load existing FAISS index, resetting: {e}")
                self._index = faiss.IndexFlatIP(self.dimension)
                self._chunks = {}
                self._chunk_ids = []
