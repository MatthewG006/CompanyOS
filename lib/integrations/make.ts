export type MakeWebhookPayload = {
  event: string;
  project?: string;
  title: string;
  content?: string;
  image_url?: string;
  target_platforms?: Array<"facebook" | "instagram" | "meta_ads" | "threads">;
  metadata?: Record<string, unknown>;
};

export async function triggerMakeWebhook(payload: MakeWebhookPayload): Promise<{ success: boolean; response: string }> {
  const webhookUrl = process.env.MAKE_META_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Make.com Meta publishing webhook URL (MAKE_META_WEBHOOK_URL) is not configured.");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "CompanyOS-Publishing/1.0",
    },
    body: JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
      source: "CompanyOS",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Make.com webhook failed (${response.status}): ${errorText}`);
  }

  const responseText = await response.text();
  return {
    success: true,
    response: responseText,
  };
}
