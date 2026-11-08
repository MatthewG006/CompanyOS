export type N8nMetaPublishPayload = {
  event?: string;
  project?: string;
  title: string;
  content?: string;
  image_url?: string;
  target_platforms?: Array<"facebook" | "instagram" | "meta_ads" | "threads">;
  metadata?: Record<string, unknown>;
};

export async function triggerN8nMetaWebhook(payload: N8nMetaPublishPayload): Promise<{ success: boolean; response: string }> {
  // Support N8N_META_WEBHOOK_URL or fallback to generic N8N_WEBHOOK_URL
  const webhookUrl = process.env.N8N_META_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("n8n Meta publishing webhook URL (N8N_META_WEBHOOK_URL) is not configured.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "CompanyOS-Publishing/1.0",
  };

  if (process.env.N8N_WEBHOOK_SECRET) {
    headers["x-companyos-n8n-secret"] = process.env.N8N_WEBHOOK_SECRET;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...payload,
      event: payload.event ?? "publish_meta_ad",
      project: payload.project ?? "Sky Mountain Graphics",
      target_platforms: payload.target_platforms ?? ["facebook", "instagram", "meta_ads"],
      timestamp: new Date().toISOString(),
      source: "CompanyOS",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`n8n webhook failed (${response.status}): ${errorText}`);
  }

  const responseText = await response.text();
  return {
    success: true,
    response: responseText,
  };
}
