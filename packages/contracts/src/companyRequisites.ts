import { z } from "zod";

export const companyRequisitesDraftSchema = z.object({
  name: z.string(),
  legalName: z.string(),
  bin: z.string(),
  iin: z.string(),
  legalAddress: z.string(),
  city: z.string(),
  iban: z.string(),
  bankName: z.string(),
  bik: z.string(),
  directorName: z.string(),
  phone: z.string(),
  email: z.string(),
});

export type CompanyRequisitesDraft = z.infer<typeof companyRequisitesDraftSchema>;

export const parseCompanyRequisitesSchema = z
  .object({
    text: z.string().max(80_000).optional(),
    fileName: z.string().min(1).max(255).optional(),
    fileBase64: z.string().max(28_000_000).optional(),
  })
  .refine((value) => Boolean(value.text?.trim()) || Boolean(value.fileBase64 && value.fileName), {
    message: "Вставьте текст реквизитов или загрузите PDF / Word",
  });

export type ParseCompanyRequisitesInput = z.infer<typeof parseCompanyRequisitesSchema>;
