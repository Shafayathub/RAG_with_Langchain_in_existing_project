import { PGVectorStore } from "@langchain/pgvector";
import pg from "pg";
import config from "../config";
import { embeddings } from "./llm";

// Neon closes idle connections, so drop ours before it does and never crash on
// an error from an idle client.
const vectorPool = new pg.Pool({
	connectionString: config.database_url,
	idleTimeoutMillis: 10_000,
	keepAlive: true,
});

vectorPool.on("error", (error) => {
	console.error("Vector store: idle database connection error", error.message);
});

// Constructed directly instead of PGVectorStore.initialize(): the table is created
// by the Prisma migration (prisma/schema/chat.prisma), and initialize() would hold
// one connection checked out for the lifetime of the app.
export const vectorStore = new PGVectorStore(embeddings, {
	pool: vectorPool,
	tableName: "doctor_embeddings",
	columns: {
		idColumnName: "id",
		vectorColumnName: "embedding",
		contentColumnName: "content",
		metadataColumnName: "metadata",
	},
	distanceStrategy: "cosine",
});
