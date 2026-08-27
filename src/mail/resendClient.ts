import { Resend } from 'resend';

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface ReceivedEmail {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

export interface WebhookEvent {
  type: string;
  data: { email_id: string; from: string; to: string[]; subject: string };
}

export interface ResendClient {
  sendEmail(params: SendEmailParams): Promise<{ id: string }>;
  getReceivedEmail(emailId: string): Promise<ReceivedEmail>;
  getAttachmentDownloadUrl(emailId: string, attachmentId: string): Promise<string>;
  verifyWebhookSignature(
    payload: string,
    headers: { id: string; timestamp: string; signature: string },
    secret: string,
  ): Promise<WebhookEvent | null>;
}

export function createResendClient(apiKey: string): ResendClient {
  const resend = new Resend(apiKey);

  return {
    async sendEmail(params) {
      const { data, error } = await resend.emails.send({
        from: params.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        headers: params.headers,
        attachments: params.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      if (error) throw new Error(`Resend send failed: ${error.message}`);
      return { id: data!.id };
    },

    async getReceivedEmail(emailId) {
      const { data, error } = await resend.emails.receiving.get(emailId);
      if (error) throw new Error(`Resend receiving.get failed: ${error.message}`);
      return {
        emailId: data!.id,
        from: data!.from,
        to: data!.to,
        subject: data!.subject,
        text: data!.text ?? '',
        html: data!.html ?? '',
        headers: data!.headers ?? {},
        attachments: data!.attachments.map((a) => ({
          id: a.id,
          filename: a.filename ?? '',
          contentType: a.content_type,
          size: a.size,
        })),
      };
    },

    async getAttachmentDownloadUrl(emailId, attachmentId) {
      const { data, error } = await resend.emails.receiving.attachments.get({ emailId, id: attachmentId });
      if (error) throw new Error(`Resend attachment fetch failed: ${error.message}`);
      return data!.download_url;
    },

    async verifyWebhookSignature(payload, headers, secret) {
      try {
        return (await resend.webhooks.verify({ payload, headers, webhookSecret: secret })) as WebhookEvent;
      } catch (err) {
        // A misconfigured RESEND_WEBHOOK_SECRET looks exactly like a bad signature, so leave a trace.
        console.warn('webhook signature verification failed:', err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}
