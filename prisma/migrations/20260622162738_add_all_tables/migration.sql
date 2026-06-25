-- CreateTable
CREATE TABLE "Estabelecimento" (
    "cnpj_base" VARCHAR(8) NOT NULL,
    "cnpj_ordem" VARCHAR(4) NOT NULL,
    "cnpj_dv" VARCHAR(2) NOT NULL,
    "identificador_matriz_filial" VARCHAR(1) NOT NULL,
    "nome_fantasia" TEXT,
    "situacao_cadastral" VARCHAR(2) NOT NULL,
    "data_situacao_cadastral" VARCHAR(8),
    "motivo_situacao_cadastral" VARCHAR(2),
    "nome_cidade_exterior" TEXT,
    "pais" VARCHAR(3),
    "data_inicio_atividade" VARCHAR(8),
    "cnae_fiscal_principal" VARCHAR(7),
    "cnae_fiscal_secundaria" TEXT,
    "tipo_logradouro" TEXT,
    "logradouro" TEXT,
    "numero" TEXT,
    "complemento" TEXT,
    "bairro" TEXT,
    "cep" VARCHAR(8),
    "uf" VARCHAR(2),
    "municipio" VARCHAR(4),
    "ddd1" VARCHAR(4),
    "telefone1" VARCHAR(9),
    "ddd2" VARCHAR(4),
    "telefone2" VARCHAR(9),
    "ddd_fax" VARCHAR(4),
    "fax" VARCHAR(9),
    "correio_eletronico" TEXT,
    "situacao_especial" TEXT,
    "data_situacao_especial" VARCHAR(8),

    CONSTRAINT "Estabelecimento_pkey" PRIMARY KEY ("cnpj_base","cnpj_ordem","cnpj_dv")
);

-- CreateTable
CREATE TABLE "Socio" (
    "id" BIGSERIAL NOT NULL,
    "cnpj_base" VARCHAR(8) NOT NULL,
    "identificador_socio" VARCHAR(1) NOT NULL,
    "nome_socio" TEXT,
    "cnpj_cpf_socio" VARCHAR(14),
    "qualificacao_socio" VARCHAR(2),
    "data_entrada_sociedade" VARCHAR(8),
    "pais" VARCHAR(3),
    "representante_legal" VARCHAR(11),
    "nome_representante" TEXT,
    "qualificacao_representante" VARCHAR(2),
    "faixa_etaria" VARCHAR(1),

    CONSTRAINT "Socio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Simples" (
    "cnpj_base" VARCHAR(8) NOT NULL,
    "opcao_simples" VARCHAR(1),
    "data_opcao_simples" VARCHAR(8),
    "data_exclusao_simples" VARCHAR(8),
    "opcao_mei" VARCHAR(1),
    "data_opcao_mei" VARCHAR(8),
    "data_exclusao_mei" VARCHAR(8),

    CONSTRAINT "Simples_pkey" PRIMARY KEY ("cnpj_base")
);

-- CreateTable
CREATE TABLE "Cnae" (
    "codigo" VARCHAR(7) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Cnae_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "Motivo" (
    "codigo" VARCHAR(2) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Motivo_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "Municipio" (
    "codigo" VARCHAR(4) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Municipio_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "Natureza" (
    "codigo" VARCHAR(4) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Natureza_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "Pais" (
    "codigo" VARCHAR(3) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Pais_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "Qualificacao" (
    "codigo" VARCHAR(2) NOT NULL,
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Qualificacao_pkey" PRIMARY KEY ("codigo")
);
