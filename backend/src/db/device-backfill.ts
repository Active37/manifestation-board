import type { PoolClient } from "pg";
import { hashIdentifier } from "../identifiers.js";

type LegacyDeviceRow = {
  row_id: string;
  device_id: string;
};

const interactionTables = [
  {
    select: `
      SELECT ctid::text AS row_id, device_id
      FROM likes
      WHERE device_id_hash_version = 0
      ORDER BY ctid
      LIMIT $1
      FOR UPDATE
    `,
    update: `
      UPDATE likes AS target
      SET device_id = source.device_id,
        device_id_hash_version = 1
      FROM unnest($1::text[], $2::text[]) AS source(row_id, device_id)
      WHERE target.ctid::text = source.row_id
    `,
    validations: [
      "ALTER TABLE likes VALIDATE CONSTRAINT likes_device_id_hash_required_check",
      "ALTER TABLE likes VALIDATE CONSTRAINT likes_device_id_hash_format_check",
    ],
  },
  {
    select: `
      SELECT ctid::text AS row_id, device_id
      FROM reports
      WHERE device_id_hash_version = 0
      ORDER BY ctid
      LIMIT $1
      FOR UPDATE
    `,
    update: `
      UPDATE reports AS target
      SET device_id = source.device_id,
        device_id_hash_version = 1
      FROM unnest($1::text[], $2::text[]) AS source(row_id, device_id)
      WHERE target.ctid::text = source.row_id
    `,
    validations: [
      "ALTER TABLE reports VALIDATE CONSTRAINT reports_device_id_hash_required_check",
      "ALTER TABLE reports VALIDATE CONSTRAINT reports_device_id_hash_format_check",
    ],
  },
] as const;

const batchSize = 500;

export async function backfillInteractionDeviceIds(
  client: PoolClient,
  secret: string,
): Promise<number> {
  let total = 0;
  for (const table of interactionTables) {
    while (true) {
      await client.query("BEGIN");
      let updatedCount = 0;
      try {
        const selected = await client.query<LegacyDeviceRow>(
          table.select,
          [batchSize],
        );
        if (selected.rows.length > 0) {
          const updated = await client.query(
            table.update,
            [
              selected.rows.map((row) => row.row_id),
              selected.rows.map((row) =>
                hashIdentifier(secret, "device", row.device_id),
              ),
            ],
          );
          if (updated.rowCount !== selected.rows.length) {
            throw new Error("Interaction device backfill updated an unexpected row count");
          }
          updatedCount = updated.rowCount;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      total += updatedCount;
      if (updatedCount === 0) {
        break;
      }
    }

    for (const validation of table.validations) {
      await client.query(validation);
    }
  }
  return total;
}
