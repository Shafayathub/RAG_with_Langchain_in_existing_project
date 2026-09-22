import { addMinutes, isBefore, isSameDay, subHours } from "date-fns";
import httpStatus from "http-status";
import PDFDocument from "pdfkit";
import {
	AppointmentStatus,
	PaymentStatus,
	Role,
	ScheduleStatus,
} from "../../../generated/prisma/enums";
import { ApppointmentWhereInput } from "../../../generated/prisma/models";
import config from "../../config";
import { IQuery } from "../../interfaces";
import { getBkashIdToken } from "../../lib/bkash";
import { transporter } from "../../lib/nodemailer";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { IBookAppointmentPayload, ICancelAppointmentPayload, IPayAppointmentPayload, IUpdateAppointmentStatusPayload } from "./appointment.interface";

const bookAppointment = async (payload: IBookAppointmentPayload , user: RequestUser) => {
	const transactionResult = await prisma.$transaction(async (tx) => {
		// business logic

		const patient = await prisma.patient.findUnique({
			where: { userId: user.userId },
		});

		if (!patient) {
			throw new AppError(httpStatus.NOT_FOUND, "Patient Profile Not Found");
		}

		const schedule = await prisma.schedule.findUnique({
			where: { id: payload.scheduleId },
			include: { doctor: true },
		});

		if (!schedule || schedule.isDeleted) {
			throw new AppError(httpStatus.NOT_FOUND, "Schedule Not Found");
		}

		if (schedule.status !== ScheduleStatus.PUBLISHED) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"This Schedule Is Not Published Yet",
			);
		}

		const now = new Date()

		if(!isSameDay(now, schedule.startDateTime)){
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"This Schedule Is Not Available Today",
			);
		}

		if(!isBefore(now, schedule.startDateTime)){
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"This Schedule Has Already Started",
			);
		}
		// if(isAfter(now, schedule.startDateTime)){
		// 	throw new AppError(
		// 		httpStatus.BAD_REQUEST,
		// 		"This Schedule Has Already Started",
		// 	);
		// }

		const existingAppointment = await prisma.apppointment.findFirst({
			where : {
				patientId : patient.id,
				scheduleId : schedule.id,
				// status : { not : AppointmentStatus.CANCELLED }
			}
		})

		if(existingAppointment?.status === AppointmentStatus.PENDING){
			throw new AppError(httpStatus.BAD_REQUEST, "You Already Have A Pending Appointment. Please Pay For That")
		}
		if(existingAppointment?.status === AppointmentStatus.CONFIRMED){
			throw new AppError(httpStatus.BAD_REQUEST, "You Already Have A Confirmed Appointment.")
		}
		if(existingAppointment?.status === AppointmentStatus.ONGOING){
			throw new AppError(httpStatus.BAD_REQUEST, "You Already Have A Ongoing Appointment")
		}
		if(existingAppointment?.status === AppointmentStatus.COMPLETED){
			throw new AppError(httpStatus.BAD_REQUEST, "You Already Have Completed An Appointment On This Schedule. Please Try Again Another Day")
		}

		if(schedule.availableSlots === 0){
			throw new AppError(httpStatus.BAD_REQUEST, "This Schedule Is Fully Booked");
		}

		if(!schedule.doctor.consultationFee){
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"Doctor Has Not Set A Consultation Fee Yet",
			);
		}

		const amount = schedule.doctor.consultationFee.toString();

		const appointment = await tx.apppointment.create({
			data: {
				status: AppointmentStatus.PENDING,
				patientId : patient.id,
				doctorId : schedule.doctor.id,
				scheduleId : schedule.id
			},
		});

		const bkashIdToken = await getBkashIdToken();

		if (!bkashIdToken) {
			throw new AppError(httpStatus.BAD_GATEWAY, "No Bkash Access Token Found!");
		}

		const bkashCreatePaymentResponse = await fetch(
			`${config.bkash_base_url}/tokenized/checkout/create`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					Authorization: bkashIdToken,
					"X-App-Key": config.bkash_app_key,
				},
				body: JSON.stringify({
					mode: "0011",
					// payerReference: "0123456789", //user email or phone number
					payerReference: user.email, //user email or phone number
					callbackURL: `${config.bkash_callback_url}/appointment/book-appointment/payment/callback`,
					amount: amount,
					currency: "BDT",
					intent: "sale",
					// merchantInvoiceNumber: "Inv4" // apppointment id
					merchantInvoiceNumber: appointment.id, // apppointment id
				}),
			},
		);

		const bkashCreatePaymentResult = await bkashCreatePaymentResponse.json();

		//paymen model create

		await tx.payment.create({
			data: {
				merchantInvoiceNumber: bkashCreatePaymentResult.merchantInvoiceNumber,
				appointmentId: appointment.id,
				amount: amount,
				gatewayResponse: bkashCreatePaymentResult,
				bkashPaymentId: bkashCreatePaymentResult.paymentID,
				payerReference: user.email,
			},
		});

		return {
			paymentUrl: bkashCreatePaymentResult.bkashURL,
		};
	});

	return transactionResult;
};

const payAppointment = async (payload: IPayAppointmentPayload, user: RequestUser) => {
	const appointmentId = payload.appointmentId;

	const existingAppointment = await prisma.apppointment.findUnique({
		where: {
			id: appointmentId,
		},
		include : {
			schedule : {
				include : {
					doctor : true
				}
			}
		}
	});

	if (!existingAppointment) {
		throw new AppError(httpStatus.NOT_FOUND, "Appointment Does Not Exists");
	}

	if (existingAppointment.status !== "PENDING") {
		throw new AppError(httpStatus.BAD_REQUEST, "Appointment Is Not Pending!");
	}

	// if (existingAppointment.status === "CANCELLED" || existingAppointment.status === "ONGOING" || existingAppointment.status === "COMPLETED"){
	//     const appointmentStatus = existingAppointment.status
	//     throw new Error(`Appointment is already ${appointmentStatus.toLowerCase}`)
	// }

	if (!existingAppointment.schedule.doctor.consultationFee){
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Doctor Has Not Set A Consultation Fee Yet",
		);
	}


	const amount = existingAppointment.schedule.doctor.consultationFee.toString();
	const bkashIdToken = await getBkashIdToken();

	if (!bkashIdToken) {
		throw new AppError(httpStatus.BAD_GATEWAY, "No Bkash Access Token Found!");
	}

	const bkashCreatePaymentResponse = await fetch(
		`${config.bkash_base_url}/tokenized/checkout/create`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: bkashIdToken,
				"X-App-Key": config.bkash_app_key,
			},
			body: JSON.stringify({
				mode: "0011",
				// payerReference: "0123456789", //user email or phone number
				payerReference: user.email, //user email or phone number
				callbackURL: `${config.bkash_callback_url}/appointment/book-appointment/payment/callback`,
				amount: amount,
				currency: "BDT",
				intent: "sale",
				// merchantInvoiceNumber: "Inv4" // apppointment id
				merchantInvoiceNumber: existingAppointment.id, // apppointment id
			}),
		},
	);

	const bkashCreatePaymentResult = await bkashCreatePaymentResponse.json();

	await prisma.payment.update({
		where: {
			appointmentId: existingAppointment.id,
		},

		data: {
			merchantInvoiceNumber: bkashCreatePaymentResult.merchantInvoiceNumber,
			gatewayResponse: bkashCreatePaymentResult,
			bkashPaymentId: bkashCreatePaymentResult.paymentID,
		},
	});

	return {
		paymentUrl: bkashCreatePaymentResult.bkashURL,
	};
};

const bookAppointmentCallback = async (query: Record<string, any>) => {
	const transactionResult = await prisma.$transaction(async (tx) => {
		const paymentId = query.paymentID;

		if (!paymentId) {
			throw new AppError(httpStatus.BAD_REQUEST, "Payment Id Missing");
		}

		const status = query.status;

		if (!status) {
			throw new AppError(httpStatus.BAD_REQUEST, "Payment Status is Missing");
		}

		const bkashIdToken = await getBkashIdToken();

		if (!bkashIdToken) {
			throw new AppError(httpStatus.BAD_GATEWAY, "No Bkash Access Token Found!");
		}

		const executedPaymentResponse = await fetch(
			`${config.bkash_base_url}/tokenized/checkout/execute`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					Authorization: bkashIdToken,
					"X-App-Key": config.bkash_app_key,
				},

				body: JSON.stringify({
					paymentID: paymentId,
				}),
			},
		);

		const executedPaymentResult = await executedPaymentResponse.json();

		if (status === "success") {

			const appointment = await prisma.apppointment.findUnique({
				where : {
					id: executedPaymentResult.merchantInvoiceNumber
				},
				include : {
					schedule : true,
					patient : true,
					doctor : true
				}
			});

			if(!appointment){
				throw new AppError(httpStatus.NOT_FOUND, "Appointment Not Found!")
			}



			

			// total slot = 3 , available slot = 2
			// (total - available) + 1

			const alreadyBookedSlots = appointment.schedule.totalSlots - appointment.schedule.availableSlots;

			const serialNumber = alreadyBookedSlots + 1

			// 25 August => 3:00 PM - 4:00 PM
			// 1st person joining time => startDateTime = 2026-08-25T15:00:00.436Z => 3:00 PM
			// serial number (1) - 1 * 20 => 0 minues

			// 2nd person joining time => startDateTime = 2026-08-25T15:20:00.436Z => 3:00 PM
			// serial number (2) - 1 * 20 => 20 minutes


			// 3nd person joining time => startDateTime = 2026-08-25T15:40:00.436Z => 3:00 PM
			// serial number (3) - 1 * 20 => 40 mintes

			const joiningTime = addMinutes(
				appointment.schedule.startDateTime, 
				(serialNumber - 1) * 20
			)

			await tx.apppointment.update({
				where: {
					id: executedPaymentResult.merchantInvoiceNumber,
					
				},
				data: {
					status: AppointmentStatus.CONFIRMED,
					joiningTime,
					serialNumber
				},
			});

			const newAvailableSlots = appointment.schedule.availableSlots - 1;

			await prisma.schedule.update({
				where : {
					id : appointment.schedule.id
				},
				data : {
					availableSlots : newAvailableSlots
				}
			})

			await tx.payment.update({
				where: {
					appointmentId: executedPaymentResult.merchantInvoiceNumber,
					bkashPaymentId: paymentId,
				},
				data: {
					status: PaymentStatus.PAID,
					bkashTrxId: executedPaymentResult.trxID,
					paidAt: executedPaymentResult.paymentExecuteTime,
					gatewayResponse: executedPaymentResult,
				},
			});

			const pdfDocument = new PDFDocument({ margin : 50});

			const pdfChunks : Buffer[] = []

			pdfDocument.on("data", (chunk : Buffer) => {
				pdfChunks.push(chunk)
			})

			const pdfReadyPromise = new Promise<Buffer>((resolve)=>{
				pdfDocument.on("end", () => {
					resolve(Buffer.concat(pdfChunks))
				})
			})

			pdfDocument.fontSize(20).text("PH Healthcare System", {align : "center"});
			pdfDocument.fontSize(14).text("Appointment Invoice", { align: "center" });
			pdfDocument.moveDown(2)

			pdfDocument.fontSize(12).text(`Patient Name: ${appointment.patient?.name}`);
			pdfDocument.text(`Patient Email: ${appointment.patient?.email}`);
			pdfDocument.moveDown();

			pdfDocument.text(`Doctor Name: ${appointment.doctor?.name}`);
			pdfDocument.text(`Specialization: ${appointment.doctor?.specialization}`);
			pdfDocument.moveDown();

			pdfDocument.text(
				`Appointment Date: ${appointment.schedule.startDateTime.toDateString()}`,
			);
			pdfDocument.text(`Your Joining Time: ${joiningTime.toString()}`);
			pdfDocument.text(`Your Serial Number: ${serialNumber}`);
			pdfDocument.text(`Meeting Link: ${appointment.schedule.meetingLink}`);
			pdfDocument.moveDown();

			pdfDocument.text(`Amount Paid: ${executedPaymentResult.amount} BDT`);
			pdfDocument.text(`Payment Method: bKash`);
			pdfDocument.text(`Transaction Id: ${executedPaymentResult.trxID}`);
			pdfDocument.text(`Paid At: ${executedPaymentResult.paymentExecuteTime}`);

			pdfDocument.end()

			const pdfBuffer = await pdfReadyPromise;

			await transporter.sendMail({
				from: config.email_sender,
				to: appointment.patient.email,
				subject: "Your Appointment Invoice - PH Healthcare System",
				text: "Thank you for booking an appointment. Please find your invoice attached.",
				attachments : [
					{
						filename: "invoice.pdf",
						content : pdfBuffer
					}
				]
			})

			return {
				redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=success`,
			};
		} else if (status === "failure") {
			await tx.payment.update({
				where: {
					bkashPaymentId: paymentId,
				},
				data: {
					status: PaymentStatus.FAILED,
					gatewayResponse: executedPaymentResult,
				},
			});
			return {
				redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=failue`,
			};
		} else if (status === "cancel") {
			await tx.payment.update({
				where: {
					bkashPaymentId: paymentId,
				},
				data: {
					status: PaymentStatus.CANCELLED,
					gatewayResponse: executedPaymentResult,
				},
			});
			return {
				executedPaymentResult,
				redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=cancel`,
			};
		} else {
			return {
				executedPaymentResult,
				redirectUrl: `${config.frontend_url}/dashboard/my-appointments?error=payment-failed`,
			};
		}
	}, {
		maxWait: 10000, // default: 2000
		timeout: 30000, // default: 5000
	});

	return transactionResult;
};

const cancelAppointment = async (payload: ICancelAppointmentPayload, user : RequestUser) => {
	const transactionResult = await prisma.$transaction(async (tx) => {
		const appointmentId = payload.appointmentId;

		const existingAppointment = await tx.apppointment.findUnique({
			where: {
				id: appointmentId,
				patient : {
					email : user.email
				}
			},
			include: {
				payment: true,
				schedule : true
			},
		});

		if (!existingAppointment) {
			throw new AppError(httpStatus.NOT_FOUND, "Appointment Does Not Exists");
		}

		if (
			existingAppointment.status === "ONGOING" ||
			existingAppointment.status === "COMPLETED"
		) {
			throw new AppError(httpStatus.BAD_REQUEST, "Appointment Ongoing or Completed");
		}

		if (existingAppointment.status === "CANCELLED") {
			throw new AppError(httpStatus.BAD_REQUEST, "Appointment Already Cancelled");
		}

		const updatedAppointment = await tx.apppointment.update({
			where: {
				id: existingAppointment.id,
			},
			data: {
				status: AppointmentStatus.CANCELLED,
			},
		});

		await prisma.schedule.update({
			where : {
				id : existingAppointment.schedule.id
			},
			data : {
				availableSlots : {increment : 1}
			}
		})

		// refund process
		const now = new Date();
		const startDateTime = existingAppointment.schedule.startDateTime; // 25 August : 3:00 PM

		// After 2:00 Pm => no refund
		// must cancel before  2:00 PM
		const refundCutOffTime = subHours(startDateTime, 1)

		// now >  refuncCutOff Time => no refund
		// now < refundCutOff Time => refund eligible
		const isEligibleForRefund = isBefore(now, refundCutOffTime)

		if(isEligibleForRefund){

			const bkashIdToken = await getBkashIdToken();

			if (!bkashIdToken) {
				throw new AppError(httpStatus.BAD_GATEWAY, "No Bkash Access Token Found!");
			}

			const bkashRefundPaymentResponse = await fetch(
				`${config.bkash_base_url}/tokenized/checkout/payment/refund`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						Authorization: bkashIdToken,
						"X-App-Key": config.bkash_app_key,
					},
					body: JSON.stringify({
						paymentID: existingAppointment.payment?.bkashPaymentId,
						trxID: existingAppointment.payment?.bkashTrxId,
						amount: existingAppointment.payment?.amount.toString(),
						sku: "Appointment Cancellation",
						reason: "Patient Cancelled The Appointment",
					}),
				},
			);

			const bkashRefundPaymentResult = await bkashRefundPaymentResponse.json();

			await tx.payment.update({
				where: {
					appointmentId: existingAppointment.id,
				},
				data: {
					refundTrxId: bkashRefundPaymentResult.refundTrxID,
					refundedAt: bkashRefundPaymentResult.completedTime,
					refundAmount: bkashRefundPaymentResult.amount,
					refundReason: "Patient Cancelled The Appointment",
					status: PaymentStatus.REFUNDED,
					gatewayResponse: bkashRefundPaymentResult,
				},
			});

		}

		const newPaymentInfo = await prisma.payment.findUnique({
			where: {
				appointmentId: existingAppointment.id,
			},
		})


		

		return {
			appointment: updatedAppointment,
			payment: newPaymentInfo,
		};
	});

	return transactionResult;
};

// DOCTOR ONLY CONFIRMED => ONGOING => COMPLETED
const updateAppointmentStatus = async (
	appointmentId : string,
	payload : IUpdateAppointmentStatusPayload,
	user : RequestUser
) => {
	const doctor = await prisma.doctor.findUnique({
		where: { userId: user.userId },
	});

	if (!doctor) {
		throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
	}

	const appointment = await prisma.apppointment.findUnique({
		where: { id: appointmentId, doctorId : doctor.id },
	});

	if (!appointment) {
		throw new AppError(httpStatus.NOT_FOUND, "Appointment Not Found");
	}

	if(appointment.status === AppointmentStatus.COMPLETED){
		throw new AppError(httpStatus.FORBIDDEN, "Appointment is already completed")
	}

	if(appointment.status === AppointmentStatus.CANCELLED){
		throw new AppError(httpStatus.FORBIDDEN, "Appointment is already cancelled")
	}
	if(appointment.status === AppointmentStatus.PENDING){
		throw new AppError(httpStatus.FORBIDDEN, "Appointment is Pending. You can change the status after appointment is confirmed")
	}

	if(appointment.status === AppointmentStatus.CONFIRMED){

		if(payload.status !== "ONGOING"){
			throw new AppError(httpStatus.BAD_REQUEST, "Confirmed Appointment Must Be Ongoing At First")
		}

		await prisma.apppointment.update({
			where : {
				id : appointment.id
			},
			data : {
				status : AppointmentStatus.ONGOING
			}
		})


	}

	if(appointment.status === AppointmentStatus.ONGOING){

		if(payload.status !== "COMPLETED"){
			throw new AppError(httpStatus.BAD_REQUEST, "Ongoinf Appointment Must Be Complted.")
		}

		await prisma.apppointment.update({
			where: {
				id: appointment.id
			},
			data: {
				status: AppointmentStatus.COMPLETED
			}
		})
	}

	const updatedAppointment = await prisma.apppointment.findUnique({
		where : {
			id : appointment.id
		}
	})

	return updatedAppointment
}

//patient appointments
const getMyAppointments = async (query : IQuery, user : RequestUser) => {


	const limit = query.limit ? Number(query.limit) : 10;
	const page = query.page ? Number(query.page) : 1;
	const skip = (page - 1) * limit;
	const sortBy = query.sortBy ? query.sortBy : "createdAt";
	const sortOrder = query.sortOrder ? query.sortOrder : "desc"

	const patient = await prisma.patient.findUnique({
		where: { userId: user.userId },
	});

	if (!patient) {
		throw new AppError(httpStatus.NOT_FOUND, "Patient Profile Not Found");
	}

	const andConditions: ApppointmentWhereInput[] = [
		{
			patientId : patient.id
		}
	];

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	const appointments = await prisma.apppointment.findMany({
		where: { AND: andConditions },
		take: limit,
		skip,
		orderBy: { [sortBy] : sortOrder},
		include: {
			doctor: { select: { id: true, name: true, specialization: true } },
			schedule: true,
			payment: true,
		},
	});

	const total = await prisma.apppointment.count({
		where: { AND: andConditions },
	});

	return {
		data: appointments,
		meta: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};


}

//doctor appointments
const getDoctorAppointments = async (query: IQuery, user: RequestUser) => {

	const limit = query.limit ? Number(query.limit) : 10;
	const page = query.page ? Number(query.page) : 1;
	const skip = (page - 1) * limit;
	const sortBy = query.sortBy ? query.sortBy : "createdAt";
	const sortOrder = query.sortOrder ? query.sortOrder : "desc"

	const doctor = await prisma.doctor.findUnique({
		where: { userId: user.userId },
	});

	if (!doctor) {
		throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile Not Found");
	}

	const andConditions: ApppointmentWhereInput[] = [
		{
			doctorId : doctor.id
		}
	];

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	const appointments = await prisma.apppointment.findMany({
		where: { AND: andConditions },
		take: limit,
		skip,
		orderBy: { [sortBy] : sortOrder},
		include: {
			patient: {
				select: { id: true, name: true, email: true, contactNumber: true },
			},
			schedule: true,
			payment: true,
		},
	});

	const total = await prisma.apppointment.count({
		where: { AND: andConditions },
	});

	return {
		data: appointments,
		meta: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};
}

//admin super admin
const getAllAppointments = async (query : IQuery) => {
	const limit = query.limit ? Number(query.limit) : 10;
	const page = query.page ? Number(query.page) : 1;
	const skip = (page - 1) * limit;
	const sortBy = query.sortBy ? query.sortBy : "createdAt";
	const sortOrder = query.sortOrder ? query.sortOrder : "desc"

	const andConditions: ApppointmentWhereInput[] = [];

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	if (query.doctorId) {
		andConditions.push({ doctorId: query.doctorId });
	}

	if (query.patientId) {
		andConditions.push({ patientId: query.patientId });
	}

	if(query.doctorEmail){
		andConditions.push({
			doctor : {
				email : query.doctorEmail
			}
		})
	}
	if(query.patientEmail){
		andConditions.push({
			patient : {
				email : query.patientEmail
			}
		})
	}

	const appointments = await prisma.apppointment.findMany({
		where: { AND: andConditions },
		take: limit,
		skip,
		orderBy: { [sortBy] : sortOrder },
		include: {
			patient: { select: { id: true, name: true, email: true } },
			doctor: { select: { id: true, name: true, specialization: true } },
			schedule: true,
			payment: true,
		},
	});

	const total = await prisma.apppointment.count({
		where: { AND: andConditions },
	});

	return {
		data: appointments,
		meta: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};


}

// for all loggedin user
const getSingleAppointment = async (appointmentId : string, user : RequestUser) => {
	const appointment = await prisma.apppointment.findUnique({
		where: { id: appointmentId },
		include: {
			patient: { select: { id: true, name: true, email: true, userId: true } },
			doctor: {
				select: { id: true, name: true, specialization: true, userId: true },
			},
			schedule: true,
			payment: true,
		},
	});

	if (!appointment) {
		throw new AppError(httpStatus.NOT_FOUND, "Appointment Not Found");
	}

	if(user.role === Role.PATIENT){
		if(appointment.patient.userId !== user.userId){
			throw new AppError(
				httpStatus.FORBIDDEN,
				"You Are Not Allowed To View This Appointment",
			);
		}
	}
	if(user.role === Role.DOCTOR){
		if(appointment.doctor.userId !== user.userId){
			throw new AppError(
				httpStatus.FORBIDDEN,
				"You Are Not Allowed To View This Appointment",
			);
		}
	}

	return appointment
}

export const AppointmentServices = {
	bookAppointment,
	payAppointment,
	bookAppointmentCallback,
	cancelAppointment,
	updateAppointmentStatus,
	getMyAppointments,
	getDoctorAppointments,
	getAllAppointments,
	getSingleAppointment,
};
