import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { createApiClient } from "@creolab/api-client";

const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
let memoryToken: string | null = null;

export const api = createApiClient({
  baseUrl: extra?.apiBaseUrl || "http://127.0.0.1:4100",
  getToken: () => memoryToken,
});

export async function saveSession(accessToken: string, refreshToken: string) {
  memoryToken = accessToken;
  await SecureStore.setItemAsync("crm_access", accessToken);
  await SecureStore.setItemAsync("crm_refresh", refreshToken);
}

export async function clearSession() {
  await SecureStore.deleteItemAsync("crm_access");
  await SecureStore.deleteItemAsync("crm_refresh");
}

export async function getAccessToken() {
  return SecureStore.getItemAsync("crm_access");
}
