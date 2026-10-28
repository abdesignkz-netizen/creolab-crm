// Keep the channel catalogue independent of delivery queues and AI configuration:
// either service can be the entry point when a worker starts.
export const aiChannelTypes = ["whatsapp_qr", "whatsapp_cloud", "telegram_bot", "instagram_direct", "website_chat"];

export function aiSourceChannel(type: string) {
  return ({ telegram_bot: "telegram", instagram_direct: "instagram", website_chat: "website_ai" } as Record<string, string>)[type] || "whatsapp";
}
