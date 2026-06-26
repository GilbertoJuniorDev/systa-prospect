-- AddIndex: composite indexes on Estabelecimento for query performance

-- Supports GET /municipios?uf= EXISTS subquery
CREATE INDEX IF NOT EXISTS "Estabelecimento_uf_municipio_idx"
  ON "Estabelecimento" ("uf", "municipio");

-- Supports POST /consulta and POST /consulta/exportar WHERE clause
CREATE INDEX IF NOT EXISTS "Estabelecimento_uf_cnae_idx"
  ON "Estabelecimento" ("uf", "cnae_fiscal_principal");
