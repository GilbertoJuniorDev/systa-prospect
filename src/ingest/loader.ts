import fs from 'fs';
import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import type { TabelaConfig } from './tables';

// ─── Escape para COPY text format ────────────────────────────────────────────

export function escapeCopy(value: string | null): string {
  if (value === null) return '\\N';
  return value
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ─── Carga de um CSV via COPY ────────────────────────────────────────────────

/**
 * Carrega um CSV na tabela de destino via staging + INSERT. Não abre/fecha
 * conexão nem controla transação: quem chama faz BEGIN/COMMIT/ROLLBACK.
 */
export async function loadCsv(
  client: Client,
  csvPath: string,
  config: TabelaConfig,
): Promise<{ rows: number; inserted: number }> {
  const nomeStaging = `${config.tabela.toLowerCase()}_staging`;
  let rows = 0;

  // Permite dois CSVs da mesma tabela na mesma transação.
  await client.query(`DROP TABLE IF EXISTS ${nomeStaging}`);
  await client.query(config.stagingDDL);

  const colunasStr = config.copyColunas.map((c) => `"${c}"`).join(', ');
  const copyStream = client.query(
    copyFrom(
      `COPY ${nomeStaging} (${colunasStr}) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`,
    ),
  );

  const rowTransform = new Transform({
    readableObjectMode: false,
    writableObjectMode: true,
    transform(row: Record<number, string>, _enc, cb) {
      const valores = config.parseRow(row);
      if (valores.length === 0) { cb(); return; }

      rows++;
      cb(null, valores.map(escapeCopy).join('\t') + '\n');
    },
  });

  await pipeline(
    fs.createReadStream(csvPath),
    iconv.decodeStream('win1252'),
    csvParser({ separator: ';', headers: false, skipComments: true }),
    rowTransform,
    copyStream,
  );

  // Para Socio não há chave natural única: INSERT direto sem ON CONFLICT
  const resultado = await client.query(`
    INSERT INTO "${config.tabela}" (${colunasStr})
    SELECT ${colunasStr} FROM ${nomeStaging}
    ${config.conflito ?? ''}
  `);

  await client.query(`DROP TABLE ${nomeStaging}`);

  return { rows, inserted: resultado.rowCount ?? 0 };
}
