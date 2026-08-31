-- BattleXJournal Migration: 014_rag_knowledge_base
-- Enables pgvector and creates tables for semantic document retrieval.

-- 1. Enable pgvector extension (Supabase has this pre-installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create documents metadata table
CREATE TABLE IF NOT EXISTS rag_documents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  title        TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'GLOBAL',
  mime_type    TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'indexing',
  checksum     TEXT NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create document chunks table
CREATE TABLE IF NOT EXISTS rag_chunks (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  chunk_index       INTEGER NOT NULL,
  heading           TEXT,
  metadata          JSONB,
  embedding         VECTOR(1536), -- 1536-dim standard OpenAI embeddings
  document_version  INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Create Indexes
CREATE INDEX IF NOT EXISTS idx_rag_documents_user_id ON rag_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_visibility ON rag_documents(visibility);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_document_id ON rag_chunks(document_id);

-- 5. HNSW Index for pgvector cosine distance search
-- If HNSW is not supported, pgvector will fall back to sequential scan, which is perfectly safe.
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_cosine ON rag_chunks USING hnsw (embedding vector_cosine_ops);
