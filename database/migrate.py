import os
import sys
from pathlib import Path
import psycopg
from dotenv import load_dotenv

# Load environment
base_dir = Path(__file__).resolve().parent.parent
load_dotenv(base_dir / ".env")

DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("DATABASE_URL must be set in the project .env file.")
MIGRATIONS_DIR = base_dir / "database" / "migrations"

def run_migrations():
    print("Connecting to configured PostgreSQL database...")
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            # Create migrations table if not exists
            cur.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    id SERIAL PRIMARY KEY,
                    filename VARCHAR(255) UNIQUE NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)

            cur.execute("SELECT filename FROM schema_migrations;")
            applied = {row[0] for row in cur.fetchall()}

            migration_files = sorted([f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql")])
            for filename in migration_files:
                if filename not in applied:
                    print(f"Applying migration: {filename}...")
                    filepath = MIGRATIONS_DIR / filename
                    with open(filepath, "r", encoding="utf-8") as sql_file:
                        sql = sql_file.read()
                        cur.execute(sql)
                    cur.execute("INSERT INTO schema_migrations (filename) VALUES (%s);", (filename,))
                    print(f"Successfully applied: {filename}")
                else:
                    print(f"Already applied: {filename}")

    print("All migrations up to date!")

if __name__ == "__main__":
    run_migrations()
