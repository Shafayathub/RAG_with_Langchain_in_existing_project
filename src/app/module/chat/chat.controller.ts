import type { Request, Response } from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import { ChatServices } from "./chat.service";

const sendMessage = catchAsync(async (req: Request, res: Response) => {
	const result = await ChatServices.sendMessage(req.body);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Chat Reply Generated Successfully",
		data: result,
	});
});

export const ChatController = {
	sendMessage,
};
