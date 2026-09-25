import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fromAddress, passwordResetEmail, verificationEmail } from "./lib/email.ts";

const previousMailFrom = process.env.MAIL_FROM;
const previousSmtpFrom = process.env.SMTP_FROM;

afterEach(() => {
  if (previousMailFrom === undefined) delete process.env.MAIL_FROM;
  else process.env.MAIL_FROM = previousMailFrom;
  if (previousSmtpFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = previousSmtpFrom;
});

describe("email sender", () => {
  it("uses the BasQar support address by default", () => {
    delete process.env.MAIL_FROM;
    delete process.env.SMTP_FROM;
    assert.equal(fromAddress(), "BasQar <support@bsqr.kz>");
  });

  it("uses the support address for registration and reset mail", () => {
    process.env.MAIL_FROM = "Old sender <info@crm.creolab.kz>";
    process.env.SMTP_FROM = "Old sender <info@crm.creolab.kz>";
    assert.equal(fromAddress(), "BasQar <support@bsqr.kz>");
    assert.equal(verificationEmail("user@example.com", "123456").subject, "Код подтверждения BasQar");
    assert.equal(passwordResetEmail("user@example.com", "123456").subject, "Восстановление пароля BasQar");
  });
});
