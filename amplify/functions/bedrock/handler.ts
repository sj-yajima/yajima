import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

// 認証情報は Lambda の実行ロールから自動取得される。
const client = new AnthropicBedrock({
  awsRegion: process.env.BEDROCK_REGION || process.env.AWS_REGION,
});

type Req = {
  prompt?: string;
  system?: string;
  modelId?: string;
  maxTokens?: number;
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Lambda Function URL のハンドラ。event.body に JSON 文字列が入る。
export const handler = async (event: { body?: string | null }) => {
  let req: Req;
  try {
    req = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const { prompt, system, modelId, maxTokens } = req;
  if (!prompt || !modelId) {
    return json(400, { error: "prompt and modelId are required" });
  }

  try {
    // 長い出力でも HTTP タイムアウトに掛からないよう、内部はストリーミングで受ける。
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: maxTokens ?? 1024,
      // 色説明は知識ベースの発散タスクなので熟考は不要。低effortで安定・高速・低コストに。
      output_config: { effort: "low" },
      system: system || undefined,
      messages: [{ role: "user", content: prompt }],
    });
    const message = await stream.finalMessage();

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("\n")
      .trim();

    return json(200, { text });
  } catch (err) {
    return json(500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
