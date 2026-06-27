-- CreateTable
CREATE TABLE "ConsultaCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultaCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsultaCache_userId_paramsHash_key" ON "ConsultaCache"("userId", "paramsHash");

-- AddForeignKey
ALTER TABLE "ConsultaCache" ADD CONSTRAINT "ConsultaCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
