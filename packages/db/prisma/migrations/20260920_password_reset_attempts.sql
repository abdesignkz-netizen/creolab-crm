-- Additive: attempt counter and purpose for password-reset codes. Safe to run more than once.

ALTER TABLE "PasswordResetToken" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PasswordResetToken" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'code';
