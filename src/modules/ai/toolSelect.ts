// Picks the most relevant tools when a company has more than the model should see at once (lexical, IDF-weighted).
const STOP = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'who', 'can', 'you', 'get', 'list', 'all', 'show', 'give', 'please', 'kya', 'hai', 'mein', 'ka', 'ki', 'ke', 'ko', 'se', 'me', 'ye', 'yeh', 'batao', 'dikhao', 'mujhe']);

export const tokenize = (s: string): string[] =>
  (s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => !STOP.has(t));

export function rankTools<T extends { name: string; text: string }>(tools: T[], queryText: string, k: number): T[] {
  if (tools.length <= k) return tools;
  const q = new Set(tokenize(queryText));
  const docs = tools.map((t) => new Set(tokenize(`${t.name} ${t.text}`)));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = tools.map((t, i) => {
    let score = 0;
    for (const w of q) if (docs[i]!.has(w)) score += Math.log(1 + tools.length / (df.get(w) ?? 1));
    return { t, score, i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).map((x) => x.t);
}
