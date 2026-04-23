/**
 * LLM Filter: Preprocess messages for TTS.
 * - Short text (<200 chars): regex-only code block removal
 * - Long text (>=200 chars): Claude Haiku summarization
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const HAIKU_THRESHOLD = 200;

export function filterForTts(content: string): string | Promise<string> {
  // Strip code blocks
  let text = content.replace(CODE_BLOCK_RE, "(コードブロック省略)");
  text = text.replace(INLINE_CODE_RE, "");
  text = text.trim();

  if (!text) return "(空のメッセージ)";

  // Short text: regex only, no API call
  if (text.length < HAIKU_THRESHOLD) {
    return text;
  }

  // Long text: summarize with Haiku
  return summarizeWithHaiku(text);
}

async function summarizeWithHaiku(text: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback: truncate
    return text.slice(0, 300) + "...";
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `以下のメッセージを音声読み上げ用に変換してください。コードブロックは「コードブロック省略」に置き換え、3行以内に要約してください。技術的な内容は平易な日本語で。\n\n${text}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    // Fallback on API error
    return text.slice(0, 300) + "...";
  }

  const data = (await res.json()) as {
    content: { type: string; text: string }[];
  };
  return data.content[0]?.text ?? text.slice(0, 300) + "...";
}
