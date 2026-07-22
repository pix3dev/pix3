/**
 * Tolerant JSON-object extraction for LLM responses. Models asked for "JSON only" still routinely
 * wrap the payload in ```json fences or sandwich it in prose — this pulls the first balanced object
 * out so the caller can parse a spec/assessment without the model's formatting getting in the way.
 */

/**
 * Extract the first well-formed JSON object from `text`. Strips a ```json / ``` fence when present,
 * otherwise scans for the first balanced `{…}` (quote/escape aware) and parses it. Throws a clear
 * Error when no parseable object is found.
 */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Expected a JSON object but the response was empty.');
  }

  let src = text.trim();
  const fenced = src.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  if (fenced) {
    src = fenced[1].trim();
  }

  const start = src.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in the response.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = src.slice(start, i + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch (error) {
          throw new Error(
            `Found a JSON object but failed to parse it: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  }

  throw new Error('Found an opening brace but no matching close — the JSON object is truncated.');
}
