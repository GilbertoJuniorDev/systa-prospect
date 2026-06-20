-- CreateTable
CREATE TABLE "Empresa" (
    "cnpj_base" VARCHAR(8) NOT NULL,
    "razao_social" TEXT NOT NULL,
    "natureza_juridica" VARCHAR(4) NOT NULL,
    "qualificacao_resp" VARCHAR(2) NOT NULL,
    "capital_social" DOUBLE PRECISION NOT NULL,
    "porte" VARCHAR(2) NOT NULL,
    "ente_federativo" TEXT,

    CONSTRAINT "Empresa_pkey" PRIMARY KEY ("cnpj_base")
);
