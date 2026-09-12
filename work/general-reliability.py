from pathlib import Path
exec(Path('work/general-edit.py').read_text().split("edit('apps/web/tsconfig.json'")[0])
edit('apps/api/src/services/notificationService.ts',lambda s:s.replace('// Dynamic import keeps worker light when web-push is not installed.','// web-push is CommonJS: its methods are on the default export.').replace('await import("web-push").catch(() => null)','await import("web-push").then((module) => module.default).catch(() => null)'))
edit('apps/api/src/services/invoiceSignedWorkflow.ts',lambda s:s.replace('actorUserId?: string | null;','actorUserId?: string | null;\n    retryOnFailure?: boolean;').replace('  } catch (error) {\n    console.error','  } catch (error) {\n    if (input.retryOnFailure) throw error;\n    console.error').replace('    contractId: payload.contractId,','    contractId: payload.contractId,\n    retryOnFailure: true,'))
def fix_outbox(s):
 a=s.index('  for (const event of due) {');b=s.index('  return due.length;',a)
 s=s[:a]+'''  for (const event of due) {
    try {
      if (event.type === "campaign.run") {
        const payload = (event.payloadJson || {}) as { campaignId?: string };
        if (payload.campaignId) await processCampaignQueue(prisma, payload.campaignId);
      } else if (event.type === "inquiry.automation") {
        const payload = (event.payloadJson || {}) as { inquiryId?: string; tenantId?: string };
        const { processInquiryAutomationJob } = await import("./inquiryAutomationQueue.ts");
        await processInquiryAutomationJob(prisma, payload);
      } else if (event.type === "contract.signed") {
        const { processContractSignedEvent } = await import("./invoiceSignedWorkflow.ts");
        await processContractSignedEvent(prisma, event);
      } else if (event.type === "avr.sent" || event.type === "esf.sent") {
        const { processEsfSentOutbox } = await import("./esfStatusSyncService.ts");
        await processEsfSentOutbox(prisma, event);
      }
    } catch (error) {
      console.error(`${event.type} outbox`, error);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + Math.min(300_000, TICK_MS * 2 ** Math.min(event.attempts, 6))),
        },
      });
      continue;
    }
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), attempts: { increment: 1 } },
    });
  }
''' +s[b:]
 return s
edit('apps/api/src/services/backgroundJobs.ts',fix_outbox)
# Integrate regressions into existing isolated HTTP suites.
def addtest(s, text):
 pos=s.rindex('\n});');return s[:pos]+text+s[pos:]
edit('apps/api/src/taskTargeting.test.ts',lambda s:addtest(s,'''
  it("создаёт задачу из команды для нового телефона и привязывает созданный контакт", async () => {
    const response = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Запланировать встречу с новым клиентом", phone: "+77019998877", contactName: "Новый контакт из команды", parsedCommand: { taskType: "meeting" }, executionMode: "prepare_only" }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.ok(body.task.contactId);
    assert.equal(body.task.contact.name, "Новый контакт из команды");
    const second = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Ещё одна встреча", phone: "+77019998877", parsedCommand: { taskType: "meeting" }, executionMode: "prepare_only" }),
    });
    assert.equal(second.status, 201);
    assert.equal((await second.json()).task.contactId, body.task.contactId);
  });
'''))
edit('apps/api/src/contact.test.ts',lambda s:addtest(s,'''
  it("очищает реквизиты, сохраняя обязательные строковые статусы", async () => {
    const response = await fetch(`${base}/api/v1/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Проверка пустых полей", phone: "+77018889977" }),
    });
    const created = await response.json();
    assert.equal(response.status, 201);
    const updated = await fetch(`${base}/api/v1/contacts/${created.client.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "", language: "", lifecycleStatus: "", leadTemperature: "", city: null }),
    });
    const body = await updated.json();
    assert.equal(updated.status, 200, JSON.stringify(body));
    const row = await prisma.contact.findUniqueOrThrow({ where: { id: created.client.id } });
    assert.equal(row.name, null);
    assert.equal(row.city, null);
    assert.equal(row.language, "unknown");
    assert.equal(row.lifecycleStatus, "new");
    assert.equal(row.leadTemperature, "unknown");
  });
'''))
