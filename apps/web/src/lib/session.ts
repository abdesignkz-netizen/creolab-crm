import { createContext, useContext } from "react";

export type Capabilities = {
  role: string | null;
  roleLabel: string;
  platformAdmin: boolean;
  companyAdmin: boolean;
  manager: boolean;
  documents: boolean;
  analytics: boolean;
  aiSettings: boolean;
  integrations: boolean;
  members: boolean;
  confirmPayments: boolean;
  manageTasks: boolean;
  exportAll: boolean;
};

export const emptyCaps: Capabilities = {
  role: null,
  roleLabel: "",
  platformAdmin: false,
  companyAdmin: false,
  manager: false,
  documents: false,
  analytics: false,
  aiSettings: false,
  integrations: false,
  members: false,
  confirmPayments: false,
  manageTasks: false,
  exportAll: false,
};

export const SessionContext = createContext<{ me: any; caps: Capabilities }>({
  me: null,
  caps: emptyCaps,
});

export function useSession() {
  return useContext(SessionContext);
}

export function useCapabilities() {
  return useSession().caps;
}

export function applyAppearance(user?: { locale?: string; theme?: string } | null) {
  const theme = user?.theme || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
  document.documentElement.lang = user?.locale === "kk" ? "kk" : user?.locale === "en" ? "en" : "ru";
}
