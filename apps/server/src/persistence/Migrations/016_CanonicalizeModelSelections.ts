import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_provider TEXT
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_provider = CASE
      WHEN default_model IS NULL THEN NULL
      WHEN lower(default_model) LIKE '%claude%' THEN 'claudeAgent'
      ELSE 'codex'
    END
    WHERE default_provider IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN provider TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET provider = COALESCE(
      (
        SELECT provider_name
        FROM projection_thread_sessions
        WHERE projection_thread_sessions.thread_id = projection_threads.thread_id
      ),
      CASE
        WHEN lower(model) LIKE '%claude%' THEN 'claudeAgent'
        ELSE 'codex'
      END,
      'codex'
    )
    WHERE provider IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_model_options_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN model_options_json TEXT
  `;

  yield* sql`
    UPDATE projection_projects
    SET
      default_model_options_json = CASE
        WHEN default_model_options_json IS NULL THEN NULL
        WHEN json_valid(default_model_options_json) = 0 THEN default_model_options_json
        WHEN json_type(default_model_options_json, '$.codex') IS NOT NULL
          OR json_type(default_model_options_json, '$.claudeAgent') IS NOT NULL
        THEN CASE
          WHEN default_provider = 'claudeAgent'
          THEN json_extract(default_model_options_json, '$.claudeAgent')
          ELSE json_extract(default_model_options_json, '$.codex')
        END
        ELSE default_model_options_json
      END
    WHERE default_model IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET
      model_options_json = CASE
        WHEN model_options_json IS NULL THEN NULL
        WHEN json_valid(model_options_json) = 0 THEN model_options_json
        WHEN json_type(model_options_json, '$.codex') IS NOT NULL
          OR json_type(model_options_json, '$.claudeAgent') IS NOT NULL
        THEN CASE
          WHEN provider = 'claudeAgent'
          THEN json_extract(model_options_json, '$.claudeAgent')
          ELSE json_extract(model_options_json, '$.codex')
        END
        ELSE model_options_json
      END
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = CASE
      WHEN json_type(payload_json, '$.defaultModel') = 'null' THEN json_remove(
        json_set(payload_json, '$.defaultModelSelection', json('null')),
        '$.defaultProvider',
        '$.defaultModel',
        '$.defaultModelOptions'
      )
      ELSE json_remove(
        json_set(
          payload_json,
          '$.defaultModelSelection',
          json_patch(
            json_object(
              'provider',
              CASE
                WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                THEN json_extract(payload_json, '$.defaultProvider')
                WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                THEN 'claudeAgent'
                ELSE 'codex'
              END,
              'model',
              json_extract(payload_json, '$.defaultModel')
            ),
            CASE
              WHEN json_type(payload_json, '$.defaultModelOptions') IS NULL THEN '{}'
              WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                OR json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
              THEN CASE
                WHEN (
                  CASE
                    WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                    THEN json_extract(payload_json, '$.defaultProvider')
                    WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                    THEN 'claudeAgent'
                    ELSE 'codex'
                  END
                ) = 'claudeAgent'
                THEN json_object(
                  'options',
                  json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                )
                ELSE json_object(
                  'options',
                  json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                )
              END
              ELSE json_object(
                'options',
                json(json_extract(payload_json, '$.defaultModelOptions'))
              )
            END
          )
        ),
        '$.defaultProvider',
        '$.defaultModel',
        '$.defaultModelOptions'
      )
    END
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_type(payload_json, '$.defaultModelSelection') IS NULL
      AND json_type(payload_json, '$.defaultModel') IS NOT NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.modelSelection',
        json_patch(
          json_object(
            'provider',
            CASE
              WHEN json_extract(payload_json, '$.provider') IS NOT NULL
              THEN json_extract(payload_json, '$.provider')
              WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
              THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'model',
            json_extract(payload_json, '$.model')
          ),
          CASE
            WHEN json_type(payload_json, '$.modelOptions') IS NULL THEN '{}'
            WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
              OR json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
            THEN CASE
              WHEN (
                CASE
                  WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                  THEN json_extract(payload_json, '$.provider')
                  WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                  THEN 'claudeAgent'
                  ELSE 'codex'
                END
              ) = 'claudeAgent'
              THEN json_object(
                'options',
                json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
              )
              ELSE json_object(
                'options',
                json(json_extract(payload_json, '$.modelOptions.codex'))
              )
            END
            ELSE json_object('options', json(json_extract(payload_json, '$.modelOptions')))
          END
        )
      ),
      '$.provider',
      '$.model',
      '$.modelOptions'
    )
    WHERE event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
      AND json_type(payload_json, '$.modelSelection') IS NULL
      AND json_type(payload_json, '$.model') IS NOT NULL
  `;
});
