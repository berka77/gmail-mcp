import {z} from 'zod';

const safeHeaderString = z.string().regex(/^[^\r\n]*$/, 'Must not contain newline characters');

export const attachmentSchema = z.object({
	filename: safeHeaderString.transform((s) => s.replaceAll('"', '')).describe('Attachment filename'),
	mimeType: safeHeaderString.describe('MIME type (e.g., application/pdf)'),
	content: z.string().describe('Base64-encoded file data'),
});

export type Attachment = z.output<typeof attachmentSchema>;

/** An image the HTML body references as `cid:`; `data` is standard base64. */
export type InlineImage = {
	mimeType: string;
	contentId: string; // With angle brackets, e.g. "<ii_abc123>"
	data: string;
};

/**
 * RFC 2047 encoding for header values (e.g. Subject). Headers must be ASCII;
 * raw UTF-8 gets mojibaked by Gmail (an em dash becomes "â€”"). Values that
 * are already ASCII pass through untouched.
 */
export function encodeHeaderValue(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) {
		return value;
	}

	// Each encoded word must stay within 75 chars and contain whole
	// characters, so chunk the string by UTF-8 byte length.
	const chunks: string[] = [];
	let chunk = '';
	for (const char of value) {
		if (Buffer.byteLength(chunk + char, 'utf-8') > 45) {
			chunks.push(chunk);
			chunk = '';
		}

		chunk += char;
	}

	chunks.push(chunk);
	return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf-8').toString('base64')}?=`).join('\r\n ');
}

/**
 * Quoted-printable encoding (RFC 2045) with soft line breaks. Without a
 * Content-Transfer-Encoding, Gmail hard-wraps long lines at ~72 chars when it
 * ingests a raw message — mid-paragraph breaks the author never wrote.
 * Soft breaks (`=\r\n`) disappear on decode, so paragraphs survive intact.
 */
export function quotedPrintableEncode(text: string): string {
	const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf-8');
	const lines: string[] = [];
	let line = '';
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (byte === 0x0d && bytes[i + 1] === 0x0a) {
			lines.push(line);
			line = '';
			i += 1;
			continue;
		}

		const literal = byte !== 0x3d && byte >= 0x20 && byte <= 0x7e;
		const token = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		if (line.length + token.length > 73) {
			lines.push(`${line}=`); // soft break
			line = '';
		}

		line += token;
	}

	lines.push(line);
	// Trailing whitespace on a line must be encoded.
	return lines.map((l) => l.replace(/ $/, '=20').replace(/\t$/, '=09')).join('\r\n');
}

/**
 * Split base64 data into 76-char lines per RFC 2045.
 */
export function formatBase64(data: string): string {
	const lines: string[] = [];
	for (let i = 0; i < data.length; i += 76) {
		lines.push(data.substring(i, i + 76));
	}

	return lines.join('\r\n');
}

function uniqueBoundary(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
}

/**
 * Appends the body content: a single text/plain or text/html part, or a
 * multipart/alternative wrapping both when an HTML body accompanies the text.
 * Both parts are quoted-printable so Gmail leaves the author's wrapping alone.
 */
function appendBodyPart(lines: string[], body: string, htmlBody?: string): void {
	const hasHtml = htmlBody !== undefined && htmlBody !== '';
	const hasText = body !== '';

	if (hasHtml && hasText) {
		const boundary = uniqueBoundary('alt');
		lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		lines.push('');

		// Least-capable form first, as clients render the last part they understand.
		lines.push(`--${boundary}`);
		lines.push('Content-Type: text/plain; charset=utf-8');
		lines.push('Content-Transfer-Encoding: quoted-printable');
		lines.push('');
		lines.push(quotedPrintableEncode(body));
		lines.push('');

		lines.push(`--${boundary}`);
		lines.push('Content-Type: text/html; charset=utf-8');
		lines.push('Content-Transfer-Encoding: quoted-printable');
		lines.push('');
		lines.push(quotedPrintableEncode(htmlBody));
		lines.push('');

		lines.push(`--${boundary}--`);
		return;
	}

	lines.push(`Content-Type: text/${hasHtml ? 'html' : 'plain'}; charset=utf-8`);
	lines.push('Content-Transfer-Encoding: quoted-printable');
	lines.push('');
	lines.push(quotedPrintableEncode(hasHtml ? htmlBody : body));
}

/**
 * Appends the body content, wrapped in multipart/related together with the
 * inline images when the HTML body has any, so its `cid:` references resolve.
 */
function appendContentPart(lines: string[], body: string, htmlBody?: string, inlineImages?: InlineImage[]): void {
	if (!htmlBody || !inlineImages || inlineImages.length === 0) {
		appendBodyPart(lines, body, htmlBody);
		return;
	}

	const boundary = uniqueBoundary('related');
	lines.push(`Content-Type: multipart/related; boundary="${boundary}"`);
	lines.push('');

	lines.push(`--${boundary}`);
	appendBodyPart(lines, body, htmlBody);
	lines.push('');

	for (const image of inlineImages) {
		lines.push(`--${boundary}`);
		lines.push(`Content-Type: ${image.mimeType}`);
		lines.push('Content-Transfer-Encoding: base64');
		lines.push(`Content-ID: ${image.contentId}`);
		lines.push('Content-Disposition: inline');
		lines.push('');
		lines.push(formatBase64(image.data));
		lines.push('');
	}

	lines.push(`--${boundary}--`);
}

/**
 * Appends MIME multipart body with attachments to an array of RFC 2822 header lines.
 * If no attachments, appends the body part on its own.
 */
export function appendMimeBody(
	lines: string[],
	body: string,
	attachments?: Attachment[],
	htmlBody?: string,
	inlineImages?: InlineImage[],
): void {
	lines.push('MIME-Version: 1.0');
	if (attachments && attachments.length > 0) {
		const boundary = uniqueBoundary('boundary');
		lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		lines.push('');

		// Body part
		lines.push(`--${boundary}`);
		appendContentPart(lines, body, htmlBody, inlineImages);
		lines.push('');

		// Attachment parts
		for (const attachment of attachments) {
			lines.push(`--${boundary}`);
			lines.push(`Content-Type: ${attachment.mimeType}`);
			lines.push('Content-Transfer-Encoding: base64');
			lines.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
			lines.push('');
			lines.push(attachment.content);
			lines.push('');
		}

		lines.push(`--${boundary}--`);
	} else {
		appendContentPart(lines, body, htmlBody, inlineImages);
	}
}
