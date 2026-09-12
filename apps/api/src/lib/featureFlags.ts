/** Temporary kill-switch for phone-call task types / command parsing. */
export const CALLS_ENABLED = false;

export type DocumentFeatureFlags = {
  documentsEnabled: boolean;
  contractSigningEnabled: boolean;
  esfIntegrationEnabled: boolean;
};

export const DEFAULT_DOCUMENT_FLAGS: DocumentFeatureFlags = {
  documentsEnabled: true,
  contractSigningEnabled: false,
  esfIntegrationEnabled: false,
};
