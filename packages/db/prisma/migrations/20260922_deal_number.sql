-- Add stable display numbers to existing and future deals; IDs and relations stay intact.
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "number" SERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS "Deal_number_key" ON "Deal"("number");
