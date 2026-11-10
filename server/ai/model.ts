// The model behind the Kept agent. Haiku 4.5 keeps a public demo cheap: every call here is a small,
// structured task (compile a rule, suggest three promises, classify a scan, write a 255-char note).
// Override with KEPT_MODEL (e.g. claude-opus-5-5) to trade cost for quality.
export const MODEL = process.env.KEPT_MODEL ?? "claude-haiku-4-5-20251001";

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** One line per Claude call in the server log, so token spend is visible on Render. */
export function logUsage(call: string, usage: Usage | undefined): void {
  if (!usage) return;
  const cached = usage.cache_read_input_tokens ? ` cached=${usage.cache_read_input_tokens}` : "";
  const wrote = usage.cache_creation_input_tokens ? ` cache_write=${usage.cache_creation_input_tokens}` : "";
  console.log(`[claude] ${call} in=${usage.input_tokens}${cached}${wrote} out=${usage.output_tokens}`);
}
