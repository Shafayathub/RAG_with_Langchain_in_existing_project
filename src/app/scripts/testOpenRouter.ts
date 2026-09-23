import { chatModel, embeddings } from "../lib/llm";

const main = async () => {
	const vector = await embeddings.embedQuery(
		"Cardiologist with 10 years of experience",
	);
	console.log("Embedding dimensions:", vector.length);
	console.log("First 5 numbers:", vector.slice(0, 5));

	const reply = await chatModel.invoke(
		"Say hello to PH Healthcare students in one short sentence.",
	);
	console.log("Chat reply:", reply.content);
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
