import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import argon2 from "argon2";
import { createPrismaClient } from "./client.ts";

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function seedDatabase() {
  const prisma = await createPrismaClient();
  const password = process.env.SEED_PASSWORD || "ChangeMeLocal1!";
  const passwordHash = await argon2.hash(password);

  const starter = await prisma.plan.upsert({
    where: { code: "starter" },
    update: {},
    create: {
      name: "Стартовый",
      code: "starter",
      limitsJson: { whatsappActive: 1, members: 20, aiMonthly: 20000 },
      featuresJson: { forms: true, webhook: true, whatsapp: true },
    },
  });

  const users = {
    platform: await prisma.user.upsert({
      where: { email: "platform@creolab.example" },
      update: { passwordHash, name: "Администратор платформы", platformAdmin: true },
      create: {
        email: "platform@creolab.example",
        passwordHash,
        name: "Администратор платформы",
        platformAdmin: true,
      },
    }),
    owner: await prisma.user.upsert({
      where: { email: "owner@creolab.example" },
      update: { passwordHash, name: "Владелец CREOLAB" },
      create: {
        email: "owner@creolab.example",
        passwordHash,
        name: "Владелец CREOLAB",
      },
    }),
    lead: await prisma.user.upsert({
      where: { email: "sales@creolab.example" },
      update: { passwordHash, name: "Руководитель продаж" },
      create: {
        email: "sales@creolab.example",
        passwordHash,
        name: "Руководитель продаж",
      },
    }),
    manager: await prisma.user.upsert({
      where: { email: "manager@creolab.example" },
      update: { passwordHash, name: "Менеджер" },
      create: {
        email: "manager@creolab.example",
        passwordHash,
        name: "Менеджер",
      },
    }),
    demoOwner: await prisma.user.upsert({
      where: { email: "owner@demo-agency.example" },
      update: { passwordHash, name: "Владелец Demo Agency" },
      create: {
        email: "owner@demo-agency.example",
        passwordHash,
        name: "Владелец Demo Agency",
      },
    }),
  };

  const creolab = await prisma.tenant.upsert({
    where: { slug: "creolab" },
    update: { name: "CREOLAB" },
    create: { name: "CREOLAB", slug: "creolab" },
  });
  const demo = await prisma.tenant.upsert({
    where: { slug: "demo-agency" },
    update: { name: "Demo Agency" },
    create: { name: "Demo Agency", slug: "demo-agency" },
  });

  await prisma.tenantPlan.createMany({
    data: [
      { tenantId: creolab.id, planId: starter.id, status: "active" },
      { tenantId: demo.id, planId: starter.id, status: "active" },
    ],
    skipDuplicates: true,
  });

  const memberships = {
    owner: await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: creolab.id, userId: users.owner.id } },
      update: { role: "owner", active: true },
      create: { tenantId: creolab.id, userId: users.owner.id, role: "owner" },
    }),
    lead: await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: creolab.id, userId: users.lead.id } },
      update: { role: "sales_lead", active: true },
      create: { tenantId: creolab.id, userId: users.lead.id, role: "sales_lead" },
    }),
    manager: await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: creolab.id, userId: users.manager.id } },
      update: { role: "manager", active: true },
      create: { tenantId: creolab.id, userId: users.manager.id, role: "manager" },
    }),
    demo: await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: demo.id, userId: users.demoOwner.id } },
      update: { role: "owner", active: true },
      create: { tenantId: demo.id, userId: users.demoOwner.id, role: "owner" },
    }),
  };

  for (const tenant of [creolab, demo]) {
    const pipeline = [
      { systemKey: "new", name: "Новая", sortOrder: 1, defaultProbability: 10 },
      { systemKey: "in_progress", name: "В работе", sortOrder: 2, defaultProbability: 20 },
      { systemKey: "need_identified", name: "Потребность выявлена", sortOrder: 3, defaultProbability: 35 },
      { systemKey: "proposal_sent", name: "КП отправлено", sortOrder: 4, defaultProbability: 50 },
      { systemKey: "negotiation", name: "Переговоры", sortOrder: 5, defaultProbability: 70 },
      { systemKey: "contract", name: "Договор", sortOrder: 6, defaultProbability: 85 },
      { systemKey: "invoiced", name: "Счёт выставлен", sortOrder: 7, defaultProbability: 90 },
    ];
    for (const def of pipeline) {
      const row = await prisma.dealStage.findFirst({ where: { tenantId: tenant.id, systemKey: def.systemKey } });
      if (row) {
        await prisma.dealStage.update({
          where: { id: row.id },
          data: {
            name: def.name,
            sortOrder: def.sortOrder,
            defaultProbability: def.defaultProbability,
          },
        });
      } else {
        await prisma.dealStage.create({
          data: {
            tenantId: tenant.id,
            systemKey: def.systemKey,
            name: def.name,
            sortOrder: def.sortOrder,
            defaultProbability: def.defaultProbability,
          },
        });
      }
    }
    const knowledge = await prisma.knowledgeVersion.findFirst({
      where: { tenantId: tenant.id, status: "published" },
    });
    if (!knowledge) {
      await prisma.knowledgeVersion.create({
        data: {
          tenantId: tenant.id,
          version: 1,
          status: "published",
          publishedAt: new Date(),
          contentJson: {
            about: tenant.slug === "creolab" ? "CREOLAB — дизайн и digital-продакшн." : "Демо-агентство для проверки изоляции.",
            services: [],
          },
        },
      });
    }
    await prisma.aIConfiguration.upsert({
      where: { id: `${tenant.id}-ai` },
      update: {},
      create: {
        id: `${tenant.id}-ai`,
        tenantId: tenant.id,
        enabled: false,
        provider: process.env.AI_PROVIDER || null,
      },
    });
  }

  const formPublicKey = "frm_creolab_site_demo";
  let formIntegration = await prisma.integration.findFirst({
    where: { tenantId: creolab.id, type: "form", name: "Форма сайта CREOLAB" },
  });
  if (!formIntegration) {
    formIntegration = await prisma.integration.create({
      data: {
        tenantId: creolab.id,
        type: "form",
        name: "Форма сайта CREOLAB",
        status: "active",
        testMode: true,
        publicKey: formPublicKey,
        assignmentJson: { kind: "owner" },
        mappingJson: { name: "name", phone: "phone", message: "message", service: "service" },
      },
    });
    await prisma.formDefinition.create({
      data: {
        tenantId: creolab.id,
        integrationId: formIntegration.id,
        publicKey: formPublicKey,
        name: "Заявка с сайта",
        fieldsJson: {
          fields: [
            { key: "name", label: "Имя", required: true },
            { key: "phone", label: "Телефон", required: true, immutableRequired: true },
            { key: "service", label: "Услуга", required: false },
            { key: "message", label: "Задача", required: false },
          ],
        },
        allowedDomains: ["https://creolab.kz", "http://localhost:5173"],
        antispamJson: { honeypot: "website" },
      },
    });
  }

  let webhook = await prisma.integration.findFirst({
    where: { tenantId: creolab.id, type: "webhook" },
  });
  if (!webhook) {
    const secret = process.env.SEED_WEBHOOK_SECRET || "whsec_dev_local_only";
    webhook = await prisma.integration.create({
      data: {
        tenantId: creolab.id,
        type: "webhook",
        name: "Серверный webhook",
        status: "active",
        testMode: true,
        secretHash: hashToken(secret),
        mappingJson: { phone: "contact.methods.phone" },
      },
    });
    console.log("Seed webhook uses SEED_WEBHOOK_SECRET or local placeholder. Hash only is stored.");
  }

  let seller = await prisma.integration.findFirst({
    where: { tenantId: creolab.id, type: "whatsapp_seller" },
  });
  if (!seller) {
    seller = await prisma.integration.create({
      data: {
        tenantId: creolab.id,
        type: "whatsapp_seller",
        name: "Текущий WhatsApp ИИ-менеджер",
        status: process.env.WHATSAPP_SELLER_URL ? "pending" : "disabled",
        testMode: true,
        schemaJson: { sellerUrlEnv: "WHATSAPP_SELLER_URL", sendOwner: "external_bot" },
      },
    });
    await prisma.channelConnection.create({
      data: {
        tenantId: creolab.id,
        integrationId: seller.id,
        channelType: "whatsapp",
        status: process.env.WHATSAPP_SELLER_URL ? "pending" : "disabled",
        autoReply: false,
        capabilitiesJson: [
          "receive_messages",
          "send_text",
          "send_media",
          "delivery_receipts",
        ],
      },
    });
  }

  const existingInquiry = await prisma.inquiry.findFirst({
    where: { tenantId: creolab.id, test: true },
  });
  if (!existingInquiry) {
    const contact = await prisma.contact.create({
      data: {
        tenantId: creolab.id,
        name: "Александр Садыков",
        firstName: "Александр",
        lastName: "Садыков",
        companyName: "ТОО Example",
        city: "Алматы",
        language: "ru",
        lifecycleStatus: "in_progress",
        leadTemperature: "hot",
        leadScore: 82,
        summary:
          "Обратился через форму после Google Ads. Интересуется корпоративным сайтом. Бюджет около 400 тыс. ₸. Следующий шаг — созвон.",
        ownerMembershipId: memberships.owner.id,
        lastContactAt: new Date(),
        attributionJson: {
          sourceType: "form",
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "website_search_almaty",
        },
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 701 000 00 01",
            normalizedValue: "77010000001",
            source: "seed_form",
            confirmed: false,
            primary: true,
          },
        },
      },
    });
    const inquiry = await prisma.inquiry.create({
      data: {
        tenantId: creolab.id,
        integrationId: formIntegration.id,
        source: "form",
        sourceType: "form",
        sourceChannel: "website",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "website_search_almaty",
        landingPage: "/website",
        contactId: contact.id,
        phoneRaw: "+7 701 000 00 01",
        phoneNormalized: "77010000001",
        phoneSource: "seed_form",
        subject: "Разработка корпоративного сайта",
        service: "Корпоративный сайт",
        description: "Нужен сайт производственной компании примерно на 10–15 страниц. Есть старый сайт.",
        budgetMin: 300000,
        budgetMax: 500000,
        currency: "KZT",
        desiredDeadline: "до октября",
        status: "accepted",
        test: true,
        assigneeMembershipId: memberships.owner.id,
        nextStep: "Позвонить сегодня после 12:00",
        fieldMetaJson: { budget: { valueSource: "form", confidence: 1 } },
      },
    });
    await prisma.task.create({
      data: {
        tenantId: creolab.id,
        type: "call",
        title: "Позвонить клиенту",
        description: "Обсудить структуру сайта и подготовить точный расчёт.",
        contactId: contact.id,
        inquiryId: inquiry.id,
        ownerMembershipId: memberships.owner.id,
        dueAt: new Date(Date.now() + 4 * 3600_000),
        status: "open",
        source: "seed",
      },
    });
    const tag = await prisma.tag.upsert({
      where: { tenantId_name: { tenantId: creolab.id, name: "B2B" } },
      update: {},
      create: { tenantId: creolab.id, name: "B2B" },
    });
    await prisma.contactTag.create({
      data: { tenantId: creolab.id, contactId: contact.id, tagId: tag.id },
    });
    await prisma.activity.create({
      data: {
        tenantId: creolab.id,
        contactId: contact.id,
        inquiryId: inquiry.id,
        type: "inquiry.created",
        title: "Получена новая заявка",
        description: "Источник: форма / Google Ads",
        actorType: "system",
      },
    });
    await prisma.note.create({
      data: {
        tenantId: creolab.id,
        parentType: "contact",
        parentId: contact.id,
        contactId: contact.id,
        text: "Не звонить до 12:00.",
        internal: true,
        pinned: true,
      },
    });

    const demoContact = await prisma.contact.create({
      data: {
        tenantId: demo.id,
        name: "Клиент другой компании",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 701 000 00 01",
            normalizedValue: "77010000001",
            source: "seed_form",
            primary: true,
          },
        },
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId: demo.id,
        source: "manual",
        contactId: demoContact.id,
        phoneRaw: "+7 701 000 00 01",
        phoneNormalized: "77010000001",
        phoneSource: "seed_manual",
        subject: "Изоляция tenant",
        description: "Тот же номер, другая компания.",
        status: "new",
        test: true,
        assigneeMembershipId: memberships.demo.id,
      },
    });

    const inbound = await prisma.inboundEvent.create({
      data: {
        tenantId: creolab.id,
        integrationId: webhook.id,
        externalEventKey: "seed-incomplete-001",
        payloadHash: hashToken("seed-incomplete-001"),
        rawJson: { message: "Нужен сайт, телефон не передали" },
        test: true,
      },
    });
    await prisma.incompleteIntake.create({
      data: {
        tenantId: creolab.id,
        inboundEventId: inbound.id,
        integrationId: webhook.id,
        reason: "missing_phone",
        status: "pending",
        rawFieldsJson: { message: "Нужен сайт, телефон не передали" },
        assigneeMembershipId: memberships.owner.id,
      },
    });
    await prisma.task.create({
      data: {
        tenantId: creolab.id,
        type: "process_inquiry",
        title: "Уточнить телефон входящего обращения",
        source: "rule",
        ownerMembershipId: memberships.owner.id,
        incompleteIntakeId: undefined,
        dedupeKey: `intake-phone:${inbound.id}`,
      },
    });
    await prisma.notification.create({
      data: {
        tenantId: creolab.id,
        episodeKey: `intake:${inbound.id}`,
        recipientMembershipId: memberships.owner.id,
        type: "needs_phone",
        priority: "normal",
        entityType: "incomplete_intake",
        entityId: inbound.id,
        title: "Требует уточнения телефона",
        body: "Входящее обращение сохранено без номера.",
      },
    });
  }

  console.log("Seed completed. Users have no required phone. Two tenants isolated.");
  console.log("Login examples: owner@creolab.example / SEED_PASSWORD");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  seedDatabase().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
