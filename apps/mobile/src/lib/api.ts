import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { createApiClient } from "@creolab/api-client";
import { useSyncExternalStore } from "react";

const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
let memoryToken: string | null = null;
let expiresAt = 0;
let restored: Promise<void> | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const baseUrl = extra?.apiBaseUrl || "http://127.0.0.1:4100";

export function useSession() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => Boolean(memoryToken));
}

export const api = createApiClient({
  baseUrl,
  getToken: getAccessToken,
});

export async function saveSession(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync("crm_access", accessToken);
  await SecureStore.setItemAsync("crm_refresh", refreshToken);
  // Renew before the server's 15-minute access-token lifetime expires.
  expiresAt = Date.now() + 14 * 60_000;
  await SecureStore.setItemAsync("crm_access_expires", String(expiresAt));
  memoryToken = accessToken;
  notify();
}

export async function clearSession() {
  memoryToken = null;
  expiresAt = 0;
  notify();
  await SecureStore.deleteItemAsync("crm_access");
  await SecureStore.deleteItemAsync("crm_refresh");
  await SecureStore.deleteItemAsync("crm_access_expires");
}

export function restoreSession() {
  if (!restored) restored = (async () => {
    memoryToken = await SecureStore.getItemAsync("crm_access");
    expiresAt = Number(await SecureStore.getItemAsync("crm_access_expires")) || 0;
    notify();
  })().catch(error => { restored = null; throw error; });
  return restored;
}

export async function getAccessToken(): Promise<string | null> {
  await restoreSession();
  if (!memoryToken || expiresAt > Date.now()) return memoryToken;
  if (!refreshing) refreshing = (async () => {
    const refreshToken = await SecureStore.getItemAsync("crm_refresh");
    if (!refreshToken) { await clearSession(); return null; }
    const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }),
    });
    if (response.status === 401) { await clearSession(); return null; }
    if (!response.ok) throw new Error("Не удалось обновить сессию. Повторите при восстановлении связи.");
    const data = await response.json();
    await saveSession(data.accessToken, data.refreshToken);
    return memoryToken;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
