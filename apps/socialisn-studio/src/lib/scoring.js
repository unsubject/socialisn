// Shared classification and scoring helpers used by list_daily_candidates,
// check_parking_lot, momentum, search_discourse, and build_thesis_brief.
// Centralized here so the audience-fit regex + saturation shape + freshness
// windows + LIKE escape only exist in one place.

export const HK_RX = /(香港|港股|港元|港府|香江|立法會|特首|金管局|HK\b|Hong\s*Kong)/i;
export const MACRO_RX = /(通脹|通胀|聯儲局|美聯儲|利率|央行|GDP|CPI|通貨膨脧|inflation|fed\b|interest\s*rate|monetary|yield|recession|美股|納指|道琼|日圓|人民幣|equity|bond|股市|外匯|經濟|財政|匯率|滞脧)/i;
export const HISTORY_RX = /(歷史|history|史上|戰後|戰前|殖民|民國|晚清|明清|唐宋|史記|抗戰|冷戰|世代|舊時)/i;

// Hours-after-first-seen at which a subject is considered dead per the
// phase 2 spec's freshness rules (HK 48h; global economics/politics/tech
// up to a week; history similar).
export const DEAD_HOURS = {
  'hong-kong': 48,
  'macro-econ': 168,
  history: 168,
  mixed: 96
};

export function classifyAudienceFit(subject, samples = []) {
  const haystack = [subject, ...(samples || [])].filter(Boolean).join(' ');
  if (HK_RX.test(haystack)) return 'hong-kong';
  if (MACRO_RX.test(haystack)) return 'macro-econ';
  if (HISTORY_RX.test(haystack)) return 'history';
  return 'mixed';
}

// Log-shaped penalty reaching 1.0 near ~20 mentions. Encodes the trend
// rule's "everyone is talking about it lowers the score".
export function saturationPenalty(mentions) {
  if (mentions <= 0) return 0;
  return Math.min(1, Math.log1p(mentions) / Math.log(20));
}

export function escapeLikeLiteral(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}
