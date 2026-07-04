-- AddIndex: composite index on Estabelecimento to support the "data de abertura"
-- month/year range filter in POST /consulta and POST /consulta/exportar

CREATE INDEX IF NOT EXISTS "Estabelecimento_uf_data_inicio_atividade_idx"
  ON "Estabelecimento" ("uf", "data_inicio_atividade");
