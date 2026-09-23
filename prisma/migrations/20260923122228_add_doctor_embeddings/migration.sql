-- Enable pgvector (required for the "vector" column type)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "doctor_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "content" TEXT,
    "metadata" JSONB,
    "embedding" vector,

    CONSTRAINT "doctor_embeddings_pkey" PRIMARY KEY ("id")
);
