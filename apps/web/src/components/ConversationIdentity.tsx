import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export const CONVERSATION_CHANNELS = [
  ["all", "Все"], ["whatsapp", "WhatsApp"], ["telegram", "Telegram"],
  ["instagram", "Instagram"], ["email", "Почта"], ["other", "Другие"],
] as const;

export function ChannelIcon({ channel }: { channel: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {channel === "telegram" ? <path d="m3 10 18-7-4 18-6-5-4 3 1-6 10-7-7 10M3 10l5 3" />
      : channel === "whatsapp" ? <><path d="M20.5 11.5a9 9 0 0 1-13.3 7.9L3 21l1.6-4.2A9 9 0 1 1 20.5 11.5Z" /><path d="m8 7 2 3-1.2 1.2a9 9 0 0 0 4 4L14 14l3 2c-1 3-4 2-7-1s-4-6-2-8Z" /></>
      : channel === "instagram" ? <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><path d="M17.5 6.5h.01" /></>
      : channel === "email" ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>
      : <><path d="M4 4h16v13H9l-5 4V4Z" /><path d="M8 9h8m-8 4h5" /></>}
  </svg>;
}

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
