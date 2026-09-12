exec(Path('work/general-edit.py').read_text().split("edit('apps/web/tsconfig.json'")[0])
edit('apps/api/src/services/aiAutomationSettingsService.ts',lambda s:s.replace('data: { settingsJson, workingHoursJson }','data: { settingsJson: settingsJson as Prisma.InputJsonObject, workingHoursJson }'))
edit('apps/api/src/services/contactService.ts',lambda s:s.replace('''      data[key] = input[key] === "" ? null : (input[key] as string);''','''      const value = input[key];
      if (value != null && typeof value !== "string") throw new ApiError(422, "invalid", `Поле ${key} должно быть строкой`);
      if (key === "language" || key === "leadTemperature") data[key] = value || "unknown";
      else if (key === "lifecycleStatus") data[key] = value || "new";
      else data[key] = value || null;'''))
edit('apps/api/src/services/conversationContextApplyService.ts',lambda s:s.replace('const applied: Record<string, unknown> =', 'const applied: { agreements: unknown[]; inquiryStatus: string | null; dealStage: string | null; suggestions: unknown[] } ='))
edit('apps/api/src/services/conversationService.ts',lambda s:s.replace('threadIds, contactPhone);','threadIds, contactPhone ?? null);').replace('threadIds, phone);','threadIds, phone ?? null);'))
edit('apps/api/src/services/documentInboxService.ts',lambda s:s.replace('function searchWhere(q: string): Prisma.ContractWhereInput','function searchWhere(q: string)').replace('mode: "insensitive"','mode: "insensitive" as const'))
edit('apps/api/src/services/domainService.ts',lambda s:s.replace('sentAt?: Date | null; updatedAt: Date','sentAt?: Date | null; updatedAt?: Date').replace('item.completedAt || item.sentAt || item.updatedAt;','item.completedAt || item.sentAt || item.updatedAt || null;').replace('      completedAt: null,\n      inquiry: null,','      completedAt: null,\n      childTasks: [],\n      inquiry: null,').replace('let contactId = input.contactId;', 'let contactId: string | null | undefined = input.contactId;'))
edit('apps/api/src/services/esfConnectionService.ts',lambda s:s.replace('  environment = connectionEnvironment(),','  environment: string = connectionEnvironment(),',1))
edit('apps/api/src/services/requestAutomationService.ts',lambda s:s.replace('export async function startAiManagerForInquiry(prisma: PrismaClient, tenantId: string, inquiryId: string) {','''export async function startAiManagerForInquiry(prisma: PrismaClient, tenantId: string, inquiryId: string): Promise<{
  inquiryId: string; status: AiProcessStatus; decision?: AutomationDecision; analysis?: RequestAnalysis;
  reason?: string; conversationId?: string;
} | null> {'''))
edit('apps/api/src/services/sellerLink.ts',lambda s:s.replace('''        channelConnections: {
          create: {
            tenantId: membership.tenantId,''','''        channelConnections: {
          create: {''',1))
edit('apps/api/src/services/taskExecutionService.ts',lambda s:s.replace('function rawSuggestedNextActions(taskType: string, resultCode?: string | null) {','''function rawSuggestedNextActions(taskType: string, resultCode?: string | null): Array<{
  type: string; title: string; dueOffsetHours: number | null; requiresConfirm?: boolean;
}> {''').replace('''    messageDraft?: string;
    contactId?: string;
    inquiryId?: string;
    conversationId?: string;
    dealId?: string;''','''    messageDraft?: string;
    contactId?: string | null;
    inquiryId?: string | null;
    conversationId?: string | null;
    dealId?: string | null;''',1))
for f in ['apps/api/package.json','package-lock.json']:
 backup=Path('work/general-before')/f
 if not backup.exists():backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,backup)
