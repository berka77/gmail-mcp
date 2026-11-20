import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {appendMimeBody, attachmentSchema, encodeHeaderValue} from '../utils/mime.js';
import {
	fetchAttachmentData, findAttachments, findInlineImages, getHeader, headerSchema, partSchema,
} from '../utils/message-parts.js';

const inputSchema = strictSchemaWithAliases({
	draftId: z.string().describe('The ID of the draft to update'),
	threadId: z.string().optional().describe('Thread to keep the draft in. Defaults to the draft\'s current thread, so reply drafts stay in their conversation.'),
	to: z.string().optional().describe('Recipient email address(es), comma-separated'),
	subject: z.string().optional().describe('Email subject'),
	body: z.string().optional().describe('Email body (plain text). Used as the plain-text alternative when htmlBody is also provided.'),
	htmlBody: z.string().optional().describe('Optional HTML body. When set alongside body, the draft is multipart/alternative; when set alone, text/html.'),
	cc: z.string().optional().describe('CC email address(es), comma-separated'),
	bcc: z.string().optional().describe('BCC email address(es), comma-separated'),
	from: z.string().optional().describe('Sender email address (for send-as aliases)'),
	attachments: z.array(attachmentSchema).optional().describe('Optional file attachments (base64-encoded)'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	message: z.object({
		id: z.string(),
		threadId: z.string(),
	}).optional(),
});

const draftSchema = z.object({
	message: z.object({
		id: z.string(),
		threadId: z.string().optional(),
		payload: z.object({
			headers: z.array(headerSchema).optional(),
			parts: z.array(partSchema).optional(),
		}).optional(),
	}),
});

type CurrentDraft = z.infer<typeof draftSchema>['message'];

/**
 * The draft as it is now, or undefined if it can't be read. A failed lookup
 * must not block the update — worst case we fall back to replacing the
 * message with exactly what the caller passed.
 */
async function getCurrentDraft(draftId: string, token: string): Promise<CurrentDraft | undefined> {
	try {
		const draft = await makeGmailApiCall('GET', `/users/me/drafts/${draftId}?format=full`, token);
		return draftSchema.parse(draft).message;
	} catch {
		return undefined;
	}
}

/** Whether the HTML body references this Content-ID (given with angle brackets). */
function referencesContentId(htmlBody: string, contentId: string): boolean {
	return htmlBody.includes(`cid:${contentId.replace(/^<|>$/g, '')}`);
}

export function registerDraftUpdate(server: McpServer, config: Config): void {
	server.registerTool(
		'draft_update',
		{
			title: 'Update draft',
			description: 'Update an existing draft. Fields left out keep their current value (recipients, subject, sender, attachments); reply headers (In-Reply-To, References) are always kept, and inline images stay when the new HTML body still references them by cid:.',
			inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
			},
		},
		async ({draftId, threadId, to, subject, body, htmlBody, cc, bcc, from, attachments}) => {
			// drafts.update replaces the whole message: anything not in the new raw
			// message is lost. Read the current draft so the update keeps what the
			// caller didn't mean to change.
			const current = await getCurrentDraft(draftId, config.token);
			const headers = current?.payload?.headers;
			const parts = current?.payload?.parts;
			const keep = (value: string | undefined, name: string) => value ?? getHeader(headers, name);

			const inlineImages = current && htmlBody
				? await Promise.all(findInlineImages(parts)
					.filter((image) => referencesContentId(htmlBody, image.contentId))
					.map(async (image) => ({
						mimeType: image.mimeType,
						contentId: image.contentId,
						data: await fetchAttachmentData(current.id, image.attachmentId, config.token),
					})))
				: undefined;

			const resolvedAttachments = attachments ?? (current
				? await Promise.all(findAttachments(parts).map(async (attachment) => ({
					filename: attachment.filename.replaceAll('"', ''),
					mimeType: attachment.mimeType,
					content: await fetchAttachmentData(current.id, attachment.attachmentId, config.token),
				})))
				: undefined);

			const resolved = {
				from: keep(from, 'From'),
				to: keep(to, 'To'),
				subject: keep(subject, 'Subject'),
				cc: keep(cc, 'Cc'),
				bcc: keep(bcc, 'Bcc'),
				inReplyTo: getHeader(headers, 'In-Reply-To'),
				references: getHeader(headers, 'References'),
			};

			const lines = [
				...(resolved.from ? [`From: ${resolved.from}`] : []),
				...(resolved.to ? [`To: ${resolved.to}`] : []),
				...(resolved.subject ? [`Subject: ${encodeHeaderValue(resolved.subject)}`] : []),
				...(resolved.cc ? [`Cc: ${resolved.cc}`] : []),
				...(resolved.bcc ? [`Bcc: ${resolved.bcc}`] : []),
				// Without these the reply detaches from the conversation in the
				// recipient's mail client, even though Gmail keeps it in the thread.
				...(resolved.inReplyTo ? [`In-Reply-To: ${resolved.inReplyTo}`] : []),
				...(resolved.references ? [`References: ${resolved.references}`] : []),
			];

			appendMimeBody(lines, body ?? '', resolvedAttachments, htmlBody, inlineImages);

			const email = lines.join('\r\n');
			const encodedEmail = Buffer.from(email).toString('base64url');

			// Without an explicit message.threadId Gmail re-threads from scratch and
			// moves the draft into a brand new thread of its own.
			const resolvedThreadId = threadId ?? current?.threadId;

			const message: {raw: string; threadId?: string} = {raw: encodedEmail};
			if (resolvedThreadId) {
				message.threadId = resolvedThreadId;
			}

			const result = await makeGmailApiCall('PUT', `/users/me/drafts/${draftId}`, config.token, {message});
			return jsonResult(outputSchema.parse(result));
		},
	);
}
