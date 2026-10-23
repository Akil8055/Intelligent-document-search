import os
from typing import List
import numpy as np
from sentence_transformers import SentenceTransformer
from config import settings

os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

class EmbeddingEngine:
    """Manages embedding generation using SentenceTransformers with L2 normalization."""

    _instance = None
    _model = None

    def __init__(self, model_name: str = settings.EMBEDDING_MODEL):
        self.model_name = model_name
        self.dimension = 384
        if EmbeddingEngine._model is None:
            print(f"Loading embedding model: {self.model_name}...")
            EmbeddingEngine._model = SentenceTransformer(self.model_name)
            print("Embedding model loaded successfully.")
        self.model = EmbeddingEngine._model

    def encode(self, texts: List[str], batch_size: int = 32) -> np.ndarray:
        """
        Encodes list of strings into L2-normalized float32 numpy vectors of shape (N, 384).
        """
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        raw_embeddings = self.model.encode(
            texts,
            batch_size=batch_size,
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=True  # Automatically L2-normalizes to unit length
        )

        embeddings = np.array(raw_embeddings, dtype=np.float32)
        if embeddings.ndim == 1:
            embeddings = np.expand_dims(embeddings, axis=0)

        return embeddings

    def encode_query(self, query: str) -> np.ndarray:
        """
        Encodes a single query into a 1D or (1, 384) normalized numpy vector.
        """
        return self.encode([query])
