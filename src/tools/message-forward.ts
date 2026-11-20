import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {encodeHeaderValue, formatBase64, quotedPrintableEncode} from '../utils/mime.js';
import {
	fetchAttachmentData, findAttachments, findInlineImages, getHeader, partSchema, type Part,
} from '../utils/message-parts.js';

const inputSchema = strictSchemaWithAliases({
	id: z.string().describe('The ID of the message to forward'),
	to: z.string().describe('Recipient email address(es), comma-separated for multiple'),
	body: z.string().optional().describe('Optional message to add above the forwarded content'),
	from: z.string().optional().describe('Sender email address (for send-as aliases)'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).optional(),
});

// Gmail message structure for fetching
const messageSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	payload: z.object({
		mimeType: z.string().optional(),
		headers: z.array(z.object({
			name: z.string(),
			value: z.string(),
		})),
		body: z.object({
			data: z.string().optional(),
			attachmentId: z.string().optional(),
		}).optional(),
		parts: z.array(partSchema).optional(),
	}),
});

/**
 * Decode base64url encoded string.
 */
function decodeBase64Url(data: string): string {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');

	return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Recursively find text content in message parts.
 */
function findTextContent(parts: Part[], mimeType: string): string | undefined {
	for (const part of parts) {
		if (part.mimeType === mimeType && part.body?.data) {
			return decodeBase64Url(part.body.data);
		}

		if (part.parts) {
			const nested = findTextContent(part.parts as Part[], mimeType);
			if (nested) {
				return nested;
			}
		}
	}

	return undefined;
}

/**
 * Extract text body from message payload.
 */
function extractBody(payload: z.infer<typeof messageSchema>['payload']): {content: string; isHtml: boolean} {
	if (payload.body?.data) {
		return {content: decodeBase64Url(payload.body.data), isHtml: false};
	}

	if (!payload.parts) {
		return {content: '', isHtml: false};
	}

	const plainText = findTextContent(payload.parts, 'text/plain');
	if (plainText) {
		return {content: plainText, isHtml: false};
	}

	const htmlText = findTextContent(payload.parts, 'text/html');
	if (htmlText) {
		return {content: htmlText, isHtml: true};
	}

	return {content: '', isHtml: false};
}

/**
 * Generate a random MIME boundary.
 */
function generateBoundary(): string {
	return `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
}

type EmailOptions = {
	to: string;
	subject: string;
	body: string;
	isHtml?: boolean;
	from?: string;
	inlineImages?: {mimeType: string; contentId: string; data: string}[];
	attachments?: {filename: string; mimeType: string; data: string}[];
};

/**
 * Create an RFC 2822 formatted email with inline images and attachments.
 */
function createRawMessage(options: EmailOptions): string {
	const hasInlineImages = options.inlineImages && options.inlineImages.length > 0;
	const hasAttachments = options.attachments && options.attachments.length > 0;

	const lines: string[] = [];

	if (options.from) {
		lines.push(`From: ${options.from}`);
	}

	lines.push(`To: ${options.to}`);
	lines.push(`Subject: ${encodeHeaderValue(options.subject)}`);
	lines.push('MIME-Version: 1.0');

	if (hasAttachments || hasInlineImages) {
		const mixedBoundary = generateBoundary();
		lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
		lines.push('');

		// Content part (either plain, html, or html with inline images)
		lines.push(`--${mixedBoundary}`);

		if (options.isHtml && hasInlineImages) {
			// multipart/related for HTML with inline images
			const relatedBoundary = generateBoundary();
			lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
			lines.push('');

			// HTML part
			lines.push(`--${relatedBoundary}`);
			lines.push('Content-Type: text/html; charset=utf-8');
			lines.push('Content-Transfer-Encoding: quoted-printable');
			lines.push('');
			lines.push(quotedPrintableEncode(options.body));

			// Inline images
			for (const img of options.inlineImages!) {
				lines.push('');
				lines.push(`--${relatedBoundary}`);
				lines.push(`Content-Type: ${img.mimeType}`);
				lines.push('Content-Transfer-Encoding: base64');
				lines.push(`Content-ID: ${img.contentId}`);
				lines.push('Content-Disposition: inline');
				lines.push('');
				lines.push(formatBase64(img.data));
			}

			lines.push('');
			lines.push(`--${relatedBoundary}--`);
		} else {
			// Simple text or HTML without inline images
			const contentType = options.isHtml ? 'text/html' : 'text/plain';
			lines.push(`Content-Type: ${contentType}; charset=utf-8`);
			lines.push('Content-Transfer-Encoding: quoted-printable');
			lines.push('');
			lines.push(quotedPrintableEncode(options.body));
		}

		// File attachments
		if (hasAttachments) {
			for (const att of options.attachments!) {
				lines.push('');
				lines.push(`--${mixedBoundary}`);
				lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
				lines.push('Content-Transfer-Encoding: base64');
				lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
				lines.push('');
				lines.push(formatBase64(att.data));
			}
		}

		lines.push('');
		lines.push(`--${mixedBoundary}--`);
	} else {
		// Simple message without attachments
		const contentType = options.isHtml ? 'text/html' : 'text/plain';
		lines.push(`Content-Type: ${contentType}; charset=utf-8`);
		lines.push('Content-Transfer-Encoding: quoted-printable');
		lines.push('');
		lines.push(quotedPrintableEncode(options.body));
	}

	const message = lines.join('\r\n');

	return Buffer.from(message)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function registerMessageForward(server: McpServer, config: Config): void {
	server.registerTool(
		'message_forward',
		{
			title: 'Forward message',
			description: 'Forward an email message to new recipients, including attachments and inline images.',
			inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({id, to, body: userMessage, from}) => {
			// Fetch the original message
			const original = await makeGmailApiCall('GET', `/users/me/messages/${id}?format=full`, config.token);
			const parsed = messageSchema.parse(original);

			// Extract headers from original
			const {headers} = parsed.payload;
			const originalFrom = getHeader(headers, 'From') ?? '';
			const originalTo = getHeader(headers, 'To') ?? '';
			const originalDate = getHeader(headers, 'Date') ?? '';
			const originalSubject = getHeader(headers, 'Subject') ?? '';
			const originalCc = getHeader(headers, 'Cc');

			// Extract body
			const {content: originalBodyContent, isHtml} = extractBody(parsed.payload);

			// Find attachments and inline images
			const attachmentInfos = findAttachments(parsed.payload.parts);
			const inlineImageInfos = findInlineImages(parsed.payload.parts);

			// Fetch all attachments and inline images in parallel
			const [attachments, inlineImages] = await Promise.all([
				Promise.all(attachmentInfos.map(async (att) => ({
					filename: att.filename,
					mimeType: att.mimeType,
					data: await fetchAttachmentData(id, att.attachmentId, config.token),
				}))),
				Promise.all(inlineImageInfos.map(async (img) => ({
					mimeType: img.mimeType,
					contentId: img.contentId,
					data: await fetchAttachmentData(id, img.attachmentId, config.token),
				}))),
			]);

			// Build forwarded subject
			const subject = originalSubject.toLowerCase().startsWith('fwd:')
				? originalSubject
				: `Fwd: ${originalSubject}`;

			// Build forwarding header and compose body
			let fullBody: string;
			if (isHtml) {
				const htmlHeader = `
<div style="margin-bottom: 20px;">
${userMessage ? `<p>${userMessage.replace(/\n/g, '<br>')}</p><br>` : ''}
<div style="color: #666; border-left: 1px solid #ccc; padding-left: 10px;">
<p>---------- Forwarded message ---------<br>
From: ${originalFrom}<br>
Date: ${originalDate}<br>
Subject: ${originalSubject}<br>
To: ${originalTo}${originalCc ? `<br>Cc: ${originalCc}` : ''}</p>
</div>
</div>
`;
				fullBody = htmlHeader + originalBodyContent;
			} else {
				const forwardHeader = [
					'---------- Forwarded message ---------',
					`From: ${originalFrom}`,
					`Date: ${originalDate}`,
					`Subject: ${originalSubject}`,
					`To: ${originalTo}`,
					...(originalCc ? [`Cc: ${originalCc}`] : []),
					'',
				].join('\n');

				fullBody = userMessage
					? `${userMessage}\n\n${forwardHeader}\n${originalBodyContent}`
					: `${forwardHeader}\n${originalBodyContent}`;
			}

			// Create the message
			const raw = createRawMessage({
				to,
				subject,
				body: fullBody,
				isHtml,
				...(from && {from}),
				inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
				attachments: attachments.length > 0 ? attachments : undefined,
			});

			// Send with threadId to keep in same thread
			const result = await makeGmailApiCall('POST', '/users/me/messages/send', config.token, {
				raw,
				threadId: parsed.threadId,
			});

			return jsonResult(outputSchema.parse(result));
		},
	);
}
