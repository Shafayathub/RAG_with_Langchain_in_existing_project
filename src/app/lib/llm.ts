import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { RunnableLambda } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import config from "../config";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const fallbackChatModels = (config.openrouter_fallback_chat_models ?? "")
	.split(",")
	.map((model) => model.trim())
	.filter(Boolean);

// OpenRouter implements the OpenAI API, so ChatOpenAI works once baseURL points to it.
const openRouterChatModel = new ChatOpenAI({
	model: config.openrouter_chat_model,
	apiKey: config.openrouter_api_key,
	temperature: 0.2,
	// OpenRouter tries these in order when a model is overloaded, rate-limited or down
	modelKwargs: {
		models: [config.openrouter_chat_model, ...fallbackChatModels],
	},
	configuration: {
		baseURL: OPENROUTER_BASE_URL,
		defaultHeaders: {
			"HTTP-Referer": config.frontend_url ?? "http://localhost:3000",
			"X-Title": "PH Healthcare",
		},
	},
});

// Free providers sometimes fail after OpenRouter has already sent HTTP 200, returning an
// error body with no message. LangChain surfaces that as a TypeError, which its retry helper
// never retries, so we rethrow it as a plain Error to make withRetry try again.
export const chatModel = RunnableLambda.from(
	async (input: BaseLanguageModelInput, options) => {
		try {
			return await openRouterChatModel.invoke(input, options);
		} catch (error) {
			throw error instanceof TypeError
				? new Error(`OpenRouter returned no completion: ${error.message}`)
				: error;
		}
	},
).withRetry({ stopAfterAttempt: 3 });

type TOpenRouterEmbeddingResponse = {
	data: { embedding: number[]; index: number }[];
};

// Minimal LangChain Embeddings implementation for OpenRouter's /embeddings endpoint.
class OpenRouterEmbeddings extends Embeddings {
	private readonly model: string;
	private readonly apiKey: string;

	constructor(model: string, apiKey: string, params: EmbeddingsParams = {}) {
		super(params);
		this.model = model;
		this.apiKey = apiKey;
	}

	private async embed(input: string[]): Promise<number[][]> {
		const response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				input,
				encoding_format: "float",
			}),
		});

		if (!response.ok) {
			throw new Error(
				`OpenRouter embeddings failed: ${response.status} ${await response.text()}`,
			);
		}

		const result = (await response.json()) as TOpenRouterEmbeddingResponse;

		return result.data
			.sort((a, b) => a.index - b.index)
			.map((item) => item.embedding);
	}

	// this.caller retries with backoff, which helps with free-tier rate limits
	async embedDocuments(texts: string[]): Promise<number[][]> {
		return this.caller.call(() => this.embed(texts));
	}

	async embedQuery(text: string): Promise<number[]> {
		const [vector] = await this.caller.call(() => this.embed([text]));
		return vector;
	}
}

export const embeddings = new OpenRouterEmbeddings(
	config.openrouter_embedding_model,
	config.openrouter_api_key,
	{ maxRetries: 3 },
);
