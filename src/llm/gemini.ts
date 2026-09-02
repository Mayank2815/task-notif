const MODEL = 'gemini-flash-latest';
/**
 * The streaming endpoint. Measured on this network, non-streaming generateContent
 * regularly returns nothing at all while streamGenerateContent completes — slowly,
 * but it completes. Without ?alt=sse it returns one JSON array of chunks.
 */
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent`;
const TIMEOUT_MS = 45_000; // long enough for a slow success, short enough not to delay the digest
const ATTEMPTS = 1; // retrying a blocked endpoint just doubles the wait

export class GeminiError extends Error {}

interface Chunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/** Joins the text out of every streamed chunk. */
export function collectText(payload: unknown): string {
  const chunks: Chunk[] = Array.isArray(payload) ? (payload as Chunk[]) : [payload as Chunk];
  const blocked = chunks.find((c) => c.promptFeedback?.blockReason);
  if (blocked) throw new GeminiError(`blocked: ${blocked.promptFeedback?.blockReason}`);

  const failed = chunks.find((c) => c.error?.message);
  if (failed) throw new GeminiError(failed.error?.message ?? 'unknown error');

  return chunks
    .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

/** Text generation over the streaming endpoint. Throws on failure; callers decide whether to degrade. */
export async function generate(apiKey: string, prompt: string): Promise<string | null> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // The key goes in the query string, not the X-goog-api-key header. Measured on this
      // network the header form is dropped outright (0 bytes, no status) while the query
      // form returns normally — consistent with a proxy filtering on that header.
      const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
        }),
        signal: controller.signal,
      });

      const raw = await res.text();
      if (!res.ok) throw new GeminiError(`gemini ${res.status}: ${raw.slice(0, 200) || '(empty body)'}`);

      const text = collectText(JSON.parse(raw));
      return text.length > 0 ? text : null;
    } catch (err) {
      lastError = err as Error;
      if (attempt === ATTEMPTS) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new GeminiError('generation failed');
}
