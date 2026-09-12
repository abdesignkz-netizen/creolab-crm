from pathlib import Path
import json, shutil

def edit(file, transform):
 p=Path(file);backup=Path('work/general-before')/file
 if not backup.exists(): backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,backup)
 s=p.read_text();t=transform(s)
 if t==s: print('UNCHANGED',file)
 p.write_text(t)

edit('apps/web/tsconfig.json',lambda s:s.replace('"noEmit": true','"noEmit": true,\n    "allowImportingTsExtensions": true'))
edit('apps/web/src/pages/DocumentsPage.tsx',lambda s:s.replace('useUrlState("kind", "")','useUrlState<(typeof KINDS)[number][0]>("kind", "", KINDS.map(([value]) => value))').replace('useUrlState("attention", "")','useUrlState<"" | "1">("attention", "", ["", "1"])').replace('useUrlState("offset", "0")','useUrlState<string>("offset", "0")'))
edit('packages/api-client/src/index.ts',lambda s:'''export type TaskDetailResponse = Record<string, unknown> & { id: string; dueAt: string | null };
export type AnalyticsTrendResponse = {
  granularity: string;
  metric: string;
  points: Array<{ label: string; value: number | null }>;
};
export type AnalyticsDashboardResponse = Record<string, unknown> & { trend: AnalyticsTrendResponse };

'''+s.replace('task: (id: string) => request(', 'task: (id: string) => request<TaskDetailResponse>(').replace('return request(`/api/v1/analytics/dashboard','return request<AnalyticsDashboardResponse>(`/api/v1/analytics/dashboard').replace('return request(`/api/v1/analytics/trend','return request<AnalyticsTrendResponse>(`/api/v1/analytics/trend'))
edit('apps/web/src/lib/signing/esfNcaLayerClient.ts',lambda s:s.replace('''    const [bundlesRaw, servicesRaw] = await Promise.all([
      this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_BUNDLES }),
      this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_SERVICES }),
    ]);''','''    // The NCALayer protocol has one response handler and no request IDs.
    const bundlesRaw = await this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_BUNDLES });
    const servicesRaw = await this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_SERVICES });'''))
edit('apps/api/src/services/aiCommandExecutionService.ts',lambda s:s.replace('return created.id;', 'return created.client.id;').replace('const details = error.details as { phone?: string } | undefined;', 'const details = error.fieldErrors;'))
edit('apps/api/src/services/campaignPersonalize.ts',lambda s:s.replace('Boolean(staffAsk) &&','staffAsk != null &&'))
edit('apps/api/src/services/campaignService.ts',lambda s:s.replace('campaign.messageSnapshot || campaign.messageDraft, attachments','campaign.messageSnapshot || campaign.messageDraft || null, attachments').replace('campaign: { ...campaign, scheduledAt: campaign.scheduledAt, status: "scheduled" }','campaign: { ...campaign, scheduledAt: campaign.scheduledAt }'))
edit('apps/api/src/services/commandComposeService.ts',lambda s:s.replace('chronological.map((message) => ({','chronological.map<ContactComposeFact["history"][number]>((message) => ({').replace('Boolean(firstName) && new RegExp','firstName != null && new RegExp'))
edit('apps/api/src/services/esfNcaLayerPocService.ts',lambda s:s.replace('if (!/^\\d{12}$/.test(sessionTin))','if (!sessionTin || !/^\\d{12}$/.test(sessionTin))'))
edit('apps/api/src/services/conversationContextService.ts',lambda s:s.replace('(status === "CONFIRMED" || status === "SCHEDULED" || status === "RESCHEDULED")', '(status === "CONFIRMED" || action === "reschedule")'))
edit('scripts/test-api.mjs',lambda s:s.replace('        OPENAI_API_KEY: "",','        ESF_PROVIDER: "mock",\n        ESF_ENV: "off",\n        ESF_ALLOW_LIVE_SEND: "0",\n        VAPID_PUBLIC_KEY: "",\n        VAPID_PRIVATE_KEY: "",\n        OPENAI_API_KEY: "",'))
