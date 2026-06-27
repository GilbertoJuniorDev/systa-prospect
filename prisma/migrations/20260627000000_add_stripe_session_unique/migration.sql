-- AddUniqueConstraint: CreditTransaction.stripeSessionId
-- Guards against double-crediting from concurrent Stripe webhook retries.
-- The application also performs an idempotency check inside the transaction,
-- but this constraint is the definitive database-level guard.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "CreditTransaction_stripeSessionId_key"
ON "CreditTransaction"("stripeSessionId")
WHERE "stripeSessionId" IS NOT NULL;
