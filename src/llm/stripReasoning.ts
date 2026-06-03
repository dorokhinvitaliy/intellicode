/**
 * Removes model reasoning blocks from an LLM response before structured parsing.
 *
 * Reasoning models (e.g. qwen3 with <think>, or our system-prompt <thinking>
 * convention) emit free-form text that often contains braces, code fences and
 * example markers. Leaving it in breaks greedy JSON/code extraction in the
 * agents. Unclosed blocks from interrupted output are dropped too.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}
