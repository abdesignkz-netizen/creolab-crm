/**
 * Optional LLM client. Used only to refine StructuredCommand JSON.
 * Never calls sendMessage / messaging providers.
 */
export async function refineCommandWithLlm(rawText: string, ruleParsed: Record<string, unknown>) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return null;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Ты парсер CRM-команд. Верни JSON с полями: taskType (proposal|message|call|follow_up|other), executionMode (execute|prepare_only), serviceCategories (WEB|PRESENTATION|ADVERTISING|BRANDING|AI[]), datePreset (today|yesterday|last_3_days|last_7_days|last_30_days|null), needsReply (bool), excludeWon (bool), proposalSentDaysAgo (number|null), clientNameQuery (string|null), intent (string), riskLevel (0-4). Не выдумывай факты. Не отправляй сообщения.",
          },
          {
            role: "user",
            content: `Команда: ${rawText}\nЧерновик правил: ${JSON.stringify(ruleParsed)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
