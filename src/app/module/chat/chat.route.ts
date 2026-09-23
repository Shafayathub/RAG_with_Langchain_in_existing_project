import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest";
import { ChatController } from "./chat.controller";
import { SendChatMessageZodSchema } from "./chat.validation";

const router = Router();

// Public (no auth), like /doctor/public/*, so patients can ask before logging in.
router.post(
	"/",
	validateRequest(SendChatMessageZodSchema),
	ChatController.sendMessage,
);

export const ChatRoutes = router;
