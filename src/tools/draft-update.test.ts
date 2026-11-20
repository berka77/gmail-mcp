import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {registerDraftUpdate} from './draft-update.js';

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

const apiCall = vi.mocked(makeGmailApiCall);

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** The message body of the drafts.update PUT the handler issued. */
const putMessage = (): {raw: string; threadId?: string} => {
	const put = apiCall.mock.calls.find(([method]) => method === 'PUT');
	return (put![3] as {message: {raw: string; threadId?: string}}).message;
};

/** The raw RFC 2822 message the handler sent. */
const putRaw = (): string => Buffer.from(putMessage().raw, 'base64url').toString('utf-8');

/** The header block of the raw message (everything before the first blank line). */
const putHeaders = (): string => putRaw().split('\r\n\r\n')[0]!;

const imageData = Buffer.from('fake-png-bytes').toString('base64url');
const pdfData = Buffer.from('fake-pdf-bytes').toString('base64url');

/** A reply draft as Gmail returns it with format=full: inline image, attachment, reply headers. */
const replyDraft = {
	id: 'draft-1',
	message: {
		id: 'msg-1',
		threadId: 'thread-abc',
		payload: {
			mimeType: 'multipart/mixed',
			headers: [
				{name: 'From', value: 'Me <me@example.com>'},
				{name: 'To', value: 'Emil <emil@example.com>'},
				{name: 'Cc', value: 'Jonny <jonny@example.com>'},
				{name: 'Bcc', value: 'Boss <boss@example.com>'},
				{name: 'Subject', value: 'Re: Kom igång'},
				{name: 'In-Reply-To', value: '<parent@example.com>'},
				{name: 'References', value: '<root@example.com> <parent@example.com>'},
			],
			parts: [
				{
					mimeType: 'multipart/related',
					parts: [
						{mimeType: 'text/html', body: {data: 'PGRpdj5vbGQ8L2Rpdj4'}},
						{
							mimeType: 'image/png',
							filename: 'screenshot.png',
							headers: [{name: 'Content-ID', value: '<ii_quoted>'}],
							body: {attachmentId: 'att-image', size: 10},
						},
						{
							mimeType: 'image/png',
							filename: 'unused.png',
							headers: [{name: 'Content-ID', value: '<ii_unused>'}],
							body: {attachmentId: 'att-unused', size: 10},
						},
					],
				},
				{
					mimeType: 'application/pdf',
					filename: 'guide.pdf',
					body: {attachmentId: 'att-pdf', size: 10},
				},
			],
		},
	},
};

describe('draft_update', () => {
	let handler: Handler;

	beforeEach(() => {
		apiCall.mockReset();
		const server = {
			registerTool: vi.fn((_name, _meta, h: Handler) => {
				handler = h;
			}),
		} as unknown as McpServer;
		registerDraftUpdate(server, {token: 'test-token'});

		apiCall.mockImplementation(async (method, endpoint) => {
			if (method === 'PUT') {
				return {id: 'draft-1', message: {id: 'msg-2', threadId: 'thread-abc'}};
			}

			if (endpoint.includes('/attachments/att-image')) {
				return {data: imageData};
			}

			if (endpoint.includes('/attachments/att-pdf')) {
				return {data: pdfData};
			}

			if (endpoint.includes('/attachments/')) {
				throw new Error(`unexpected attachment fetch: ${endpoint}`);
			}

			return replyDraft;
		});
	});

	it('keeps the draft in its existing thread', async () => {
		await handler({draftId: 'draft-1', body: 'updated'});

		expect(apiCall).toHaveBeenCalledWith('GET', '/users/me/drafts/draft-1?format=full', 'test-token');
		expect(putMessage().threadId).toBe('thread-abc');
	});

	it('prefers an explicitly supplied threadId', async () => {
		await handler({draftId: 'draft-1', body: 'updated', threadId: 'thread-xyz'});

		expect(putMessage().threadId).toBe('thread-xyz');
	});

	it('keeps the reply headers so the recipient\'s client threads the reply', async () => {
		await handler({draftId: 'draft-1', body: 'updated'});

		expect(putHeaders()).toContain('In-Reply-To: <parent@example.com>');
		expect(putHeaders()).toContain('References: <root@example.com> <parent@example.com>');
	});

	it('keeps recipients, sender and subject that are left out', async () => {
		await handler({draftId: 'draft-1', body: 'updated'});

		const headers = putHeaders();
		expect(headers).toContain('From: Me <me@example.com>');
		expect(headers).toContain('To: Emil <emil@example.com>');
		expect(headers).toContain('Cc: Jonny <jonny@example.com>');
		expect(headers).toContain('Bcc: Boss <boss@example.com>');
		expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?/m);
	});

	it('replaces fields that are passed', async () => {
		await handler({
			draftId: 'draft-1', body: 'updated', to: 'new@example.com', subject: 'New subject',
		});

		const headers = putHeaders();
		expect(headers).toContain('To: new@example.com');
		expect(headers).toContain('Subject: New subject');
		expect(headers).not.toContain('emil@example.com');
	});

	it('keeps inline images the new HTML body still references, and drops the rest', async () => {
		await handler({draftId: 'draft-1', body: 'updated', htmlBody: '<div>new</div><img src="cid:ii_quoted">'});

		const raw = putRaw();
		expect(raw).toContain('Content-Type: multipart/related');
		expect(raw).toContain('Content-ID: <ii_quoted>');
		expect(raw).toContain(Buffer.from('fake-png-bytes').toString('base64'));
		expect(raw).not.toContain('<ii_unused>');
		expect(apiCall).toHaveBeenCalledWith('GET', '/users/me/messages/msg-1/attachments/att-image', 'test-token');
	});

	it('keeps existing attachments when none are passed', async () => {
		await handler({draftId: 'draft-1', body: 'updated'});

		const raw = putRaw();
		expect(raw).toContain('Content-Disposition: attachment; filename="guide.pdf"');
		expect(raw).toContain(Buffer.from('fake-pdf-bytes').toString('base64'));
	});

	it('replaces attachments when they are passed', async () => {
		await handler({
			draftId: 'draft-1',
			body: 'updated',
			attachments: [{filename: 'new.txt', mimeType: 'text/plain', content: Buffer.from('hi').toString('base64')}],
		});

		const raw = putRaw();
		expect(raw).toContain('filename="new.txt"');
		expect(raw).not.toContain('guide.pdf');
	});

	it('still updates when the draft has no thread', async () => {
		apiCall.mockImplementation(async (method) => (method === 'GET'
			? {id: 'draft-1', message: {id: 'msg-1'}}
			: {id: 'draft-1', message: {id: 'msg-2', threadId: 'thread-new'}}));

		await handler({draftId: 'draft-1', body: 'updated'});

		expect(putMessage()).not.toHaveProperty('threadId');
	});

	it('still updates with exactly what was passed when the lookup fails', async () => {
		apiCall.mockImplementation(async (method) => {
			if (method === 'GET') {
				throw new Error('Gmail API error: 404 Not Found');
			}

			return {id: 'draft-1', message: {id: 'msg-2', threadId: 'thread-new'}};
		});

		await expect(handler({draftId: 'draft-1', body: 'updated', to: 'a@example.com'})).resolves.toBeDefined();
		expect(putMessage()).not.toHaveProperty('threadId');
		expect(putHeaders()).toBe('To: a@example.com\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable');
	});
});
