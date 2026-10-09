import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ChannelIcon } from "./ChannelIcon";
export { ChannelIcon } from "./ChannelIcon";

export const CONVERSATION_CHANNELS = [
  ["all", "Все"], ["whatsapp", "WhatsApp"], ["telegram", "Telegram"],
  ["instagram", "Instagram"], ["email", "Почта"], ["other", "Другие"],
] as const;

// Initials remain visible while a channel photo loads or when it is private/unavailable.
export function ConversationAvatar({ name, channel, conversationId, small = false }: { name: string; channel?: string; conversationId?: string; small?: boolean }) {
  const element = useRef<HTMLSpanElement>(null);
  const [photo, setPhoto] = useState<{ id: string; tenant: string; url: string }>();
  const tenant = localStorage.getItem("crm_tenant") || "";
  useEffect(() => {
    if (!conversationId || !["whatsapp", "telegram"].includes(channel || "") || !element.current) return;
    let disposed = false; let objectUrl: string | undefined;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void api.conversationAvatar(conversationId).then(({ blob }) => {
        if (disposed || !blob.size || !blob.type.startsWith("image/")) return;
        objectUrl = URL.createObjectURL(blob);
        setPhoto({ id: conversationId, tenant, url: objectUrl });
      }).catch(() => { /* Photos are optional; communication remains available. */ });
    });
    observer.observe(element.current);
    return () => { disposed = true; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [conversationId, channel, tenant]);
  const words = name.trim().split(/\s+/).filter(word => /[\p{L}]/u.test(word));
  const initials = words.slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase("ru") || "?";
  const tone = [...name].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5;
  return <span ref={element} className={`conversation-avatar avatar-tone-${tone}${small ? " small" : ""}`} aria-hidden="true">
    {initials}
    {photo?.id === conversationId && photo?.tenant === tenant ? <img src={photo.url} alt="" onError={() => setPhoto(undefined)} /> : null}
    {channel ? <span className={`avatar-channel channel-${channel}`}><ChannelIcon channel={channel} /></span> : null}
  </span>;
}
