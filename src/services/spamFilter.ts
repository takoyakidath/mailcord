export interface SpamCheckInput {
  subject: string;
  text: string;
}

export interface SpamCheckResult {
  isSpam: boolean;
  reasons: string[];
}

// A small curated list of phrases that show up disproportionately often in unsolicited mail.
// Intentionally simple (substring match, case-insensitive) rather than a trained classifier —
// good enough to catch the obvious junk this personal/small-team bot actually receives.
const SPAM_KEYWORDS = [
  '当選しました',
  '当選者に選ばれました',
  '今すぐクリック',
  '至急ご確認ください',
  'アカウントが停止されました',
  '未払い料金',
  '副業で稼',
  '出会い系',
  'click here now',
  'you have won',
  'you have been selected',
  'wire transfer',
  'nigerian prince',
  'viagra',
  'casino bonus',
  'lottery winner',
  'act now',
  'limited time offer',
  'risk free',
];

const EXCLAMATION_THRESHOLD = 3;

function isShoutingSubject(subject: string): boolean {
  const letters = subject.replace(/[^A-Za-z]/g, '');
  return letters.length >= 6 && letters === letters.toUpperCase();
}

export function classifySpam(input: SpamCheckInput): SpamCheckResult {
  const reasons: string[] = [];
  const haystack = `${input.subject}\n${input.text}`.toLowerCase();

  for (const keyword of SPAM_KEYWORDS) {
    if (haystack.includes(keyword.toLowerCase())) {
      reasons.push(`spam keyword: "${keyword}"`);
    }
  }

  const exclamations = (input.subject.match(/!/g) ?? []).length;
  if (exclamations >= EXCLAMATION_THRESHOLD) {
    reasons.push('excessive exclamation marks in subject');
  }

  if (isShoutingSubject(input.subject)) {
    reasons.push('subject is all caps');
  }

  return { isSpam: reasons.length > 0, reasons };
}
