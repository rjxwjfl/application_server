const { Pool } = require("pg");

let pool;

function setPool(pgPool) {
  pool = pgPool;
}

class EventDAO {
  async createEvent(data) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Insert Event
      const eventQuery = `
                INSERT INTO events (
                    id, drawer_id, series_id, author_id, summary, 
                    description, color, r_rule, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                )
            `;
      await client.query(eventQuery, [
        data.id,
        data.drawerId,
        data.seriesId,
        data.authorId,
        data.summary,
        data.description || null,
        data.color,
        data.rRule || null,
        data.createdAt,
        data.updatedAt
      ]);

      // 2. Insert Event Instances and Participants
      for (const instance of data.instances) {
        // Insert Event Instance
        const eventInstanceQuery = `
                    INSERT INTO event_instances (
                        id, event_id, summary, description, location,
                        is_all_day, original_date, start_date, end_date,
                        created_at, updated_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                    )
                `;
        await client.query(eventInstanceQuery, [
          instance.id,
          instance.eventId,
          instance.summary || null,
          instance.description || null,
          instance.locations ? JSON.stringify(instance.locations) : null,
          instance.isAllDay,
          instance.originalDate,
          instance.startDate,
          instance.endDate,
          instance.createdAt,
          instance.updatedAt
        ]);

        // Insert Instance Participants
        for (const participant of instance.participants) {
          const instanceParticipantsQuery = `
                        INSERT INTO event_instance_user (
                            instance_id, user_id, state, created_at, updated_at
                        ) VALUES (
                            $1, $2, $3, $4, $5
                        )
                    `;
          await client.query(instanceParticipantsQuery, [instance.id, participant.userId, participant.state, participant.createdAt, participant.updatedAt]);
        }
      }

      module.exports = { EventDAO, setPool };
      return { success: true, eventId: data.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
