export function appendToReferencesChain(existingChain: string | null, messageId: string): string {
  const ids = existingChain ? existingChain.split(' ').filter(Boolean) : [];
  ids.push(messageId);
  return ids.join(' ');
}

export interface ReplyHeaders {
  inReplyTo: string;
  references: string;
}

export function buildReplyHeaders(
  originalMessageId: string,
  existingReferencesChain: string | null,
): ReplyHeaders {
  return {
    inReplyTo: originalMessageId,
    references: appendToReferencesChain(existingReferencesChain, originalMessageId),
  };
}

export function buildReplySubject(originalSubject: string): string {
  return originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
}
