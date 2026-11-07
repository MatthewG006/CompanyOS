export type DalleImageOptions = {
  prompt: string;
  size?: "1024x1024" | "1024x1792" | "1792x1024";
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
};

export type DalleImageResult = {
  url: string;
  revised_prompt?: string;
};

export async function generateDalleImage(options: DalleImageOptions): Promise<DalleImageResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OpenAI API key (OPENAI_API_KEY) is not configured.");

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_DALLE_MODEL || "dall-e-3",
      prompt: options.prompt,
      n: 1,
      size: options.size ?? "1024x1024",
      quality: options.quality ?? "standard",
      style: options.style ?? "vivid",
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI DALL-E error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ url: string; revised_prompt?: string }>;
  };

  const image = data.data?.[0];
  if (!image?.url) throw new Error("DALL-E completed without returning an image URL.");

  return {
    url: image.url,
    revised_prompt: image.revised_prompt,
  };
}
