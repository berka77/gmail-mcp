import {z} from 'zod';
import {makeGmailApiCall} from './gmail-api.js';

export const headerSchema = z.object({
	name: z.string(),
	value: z.string(),
});

export const partSchema = z.object({
	mimeType: z.string().optional(),
	filename: z.string().optional(),
	headers: z.array(headerSchema).optional(),
	body: z.object({
		data: z.string().optional(),
		attachmentId: z.string().optional(),
		size: z.number().optional(),
	}).optional(),
	parts: z.array(z.any()).optional(),
});

export type Part = z.infer<typeof partSchema>;

export type AttachmentRef = {
	filename: string;
	mimeType: string;
	attachmentId: string;
};

export type InlineImageRef = {
	mimeType: string;
	contentId: string;
	attachmentId: string;
};

/**
 * Extract a header value (case-insensitive) from a headers array.
 */
export function getHeader(headers: {name: string; value: string}[] | undefined, name: string): string | undefined {
	return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Convert base64url to standard, padded base64.
 */
export function base64UrlToBase64(data: string): string {
	let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	while (base64.length % 4) {
		base64 += '=';
	}

	return base64;
}

/**
 * Find regular attachments (files with filename, no Content-ID).
 */
export function findAttachments(parts: Part[] | undefined): AttachmentRef[] {
	const attachments: AttachmentRef[] = [];

	if (!parts) {
		return attachments;
	}

	for (const part of parts) {
		const contentId = getHeader(part.headers, 'Content-ID');
		// Regular attachment: has filename but no Content-ID (not inline)
		if (part.body?.attachmentId && part.filename && !contentId) {
			attachments.push({
				filename: part.filename,
				mimeType: part.mimeType ?? 'application/octet-stream',
				attachmentId: part.body.attachmentId,
			});
		}

		if (part.parts) {
			attachments.push(...findAttachments(part.parts as Part[]));
		}
	}

	return attachments;
}

/**
 * Find inline images (parts with Content-ID header).
 */
export function findInlineImages(parts: Part[] | undefined): InlineImageRef[] {
	const images: InlineImageRef[] = [];

	if (!parts) {
		return images;
	}

	for (const part of parts) {
		const contentId = getHeader(part.headers, 'Content-ID');
		if (contentId && part.body?.attachmentId && part.mimeType?.startsWith('image/')) {
			images.push({
				mimeType: part.mimeType,
				contentId, // e.g., "<image.png>"
				attachmentId: part.body.attachmentId,
			});
		}

		if (part.parts) {
			images.push(...findInlineImages(part.parts as Part[]));
		}
	}

	return images;
}

/**
 * Download an attachment of a message (or of a draft's message) as standard base64.
 */
export async function fetchAttachmentData(messageId: string, attachmentId: string, token: string): Promise<string> {
	const resp = await makeGmailApiCall('GET', `/users/me/messages/${messageId}/attachments/${attachmentId}`, token);
	return base64UrlToBase64(z.object({data: z.string()}).parse(resp).data);
}
