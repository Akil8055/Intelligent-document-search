import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

PROJECT_ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    HOST: str = "127.0.0.1"
    PORT: int = 8000
    DATABASE_URL: str = ""
    UPLOAD_DIR: str = str(PROJECT_ROOT / "data" / "uploads")
    EMBEDDING_MODEL: str = "sentence-transformers/all-MiniLM-L6-v2"
    RERANKER_MODEL: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    FAISS_INDEX_PATH: str = str(Path(__file__).resolve().parent / "data" / "faiss_index.bin")
    FAISS_METADATA_PATH: str = str(Path(__file__).resolve().parent / "data" / "faiss_metadata.json")
    DEFAULT_CHUNK_SIZE: int = 500  # approximate words/tokens
    DEFAULT_CHUNK_OVERLAP: int = 75

    model_config = SettingsConfigDict(env_file=str(PROJECT_ROOT / ".env"), extra="ignore")

settings = Settings()
