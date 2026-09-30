import { randomBytes } from 'node:crypto';
import type { OutboundAttachment } from './resendClient';

// Resend's SDK accepts structured from/to/subject/text/attachments and builds the RFC822
// message itself; the Gmail API instead wants the whole message pre-built and base64url-encoded
// (`users.messages.send` with `raw`), so outbound Gmail sends need this builder that Resend sends
// never did.

export interface Rfc822MessageParams {
  from: string;
  to: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  attachments?: OutboundAttachment[];
}

const CRLF = '\r\n';

// RFC 2047 "encoded word" (base64/B) — Subject/From routinely contain Japanese text, which must
// not be emitted as raw UTF-8 bytes in a header.
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// RFC 2045 caps base64 body lines at 76 chars; some parsers are strict about it.
function wrapBase64(base64: string): string {
  return base64.replace(/.{76}/g, (line) => `${line}${CRLF}`);
}

function textPart(boundary: string | null, body: string): string {
  const contentHeaders = `Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64`;
  const encoded = wrapBase64(Buffer.from(body, 'utf8').toString('base64'));
  return boundary
    ? `--${boundary}${CRLF}${contentHeaders}${CRLF}${CRLF}${encoded}${CRLF}`
    : `${contentHeaders}${CRLF}${CRLF}${encoded}${CRLF}`;
}

function attachmentPart(boundary: string, attachment: OutboundAttachment): string {
  const contentType = attachment.contentType ?? 'application/octet-stream';
  const headers = [
    `Content-Type: ${contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
  ].join(CRLF);
  return `--${boundary}${CRLF}${headers}${CRLF}${CRLF}${wrapBase64(attachment.content.toString('base64'))}${CRLF}`;
}

export function buildRfc822Message(params: Rfc822MessageParams): Buffer {
  const attachments = params.attachments ?? [];
  const headerLines = [
    `From: ${encodeHeaderValue(params.from)}`,
    `To: ${params.to}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(params.headers).map(([name, value]) => `${name}: ${value}`),
  ];

  if (attachments.length === 0) {
    return Buffer.from(`${headerLines.join(CRLF)}${CRLF}${textPart(null, params.body)}`, 'utf8');
  }

  const boundary = `mailcord_${randomBytes(12).toString('hex')}`;
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [textPart(boundary, params.body), ...attachments.map((a) => attachmentPart(boundary, a)), `--${boundary}--`];
  return Buffer.from(`${headerLines.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}${CRLF}`, 'utf8');
}
