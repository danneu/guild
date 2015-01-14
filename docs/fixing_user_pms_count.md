I originally copy and pasted the database trigger that maintains
`users.posts_count` which is obviously incorrect because a new PM must update
the `pms_count` of all users that are participants of the parent convo.

# Fixing `users.pms_count`

Here's the fixed trigger:

    CREATE OR REPLACE FUNCTION update_user_pms_count() RETURNS trigger AS
    $$
      var q, delta = 0, convoId;

      q = 'UPDATE users                                          '+
          'SET pms_count = pms_count + $1                        '+
          'WHERE id IN (                                         '+
          '  SELECT cp.user_id                                   '+
          '  FROM convos c                                       '+
          '  JOIN convos_participants cp ON c.id = cp.convo_id   '+
          '  WHERE c.id = $2                                     '+
          ')                                                     ';

      delta = 0;
      if (TG_OP === 'INSERT') delta++;
      if (TG_OP === 'DELETE') delta--;

      convoId = (OLD && OLD.convo_id) || (NEW && NEW.convo_id);

      plv8.execute(q, [delta, convoId]);
    $$ LANGUAGE 'plv8';

    DROP TRIGGER IF EXISTS update_user_pms_count_trigger ON pms;
    CREATE TRIGGER update_user_pms_count_trigger
        AFTER INSERT OR DELETE ON pms
        FOR EACH ROW
        EXECUTE PROCEDURE update_user_pms_count();

After this is applied to the prod database, I need to execute this UPDATE query
to fix everyone's `pms_count`. Note: This assume that `convos.pms_count` is 
accurate.

    UPDATE users
    SET pms_count = sub.pms_count
    FROM (
      SELECT SUM(c.pms_count) "pms_count", cp.user_id
      FROM convos c
      JOIN convos_participants cp ON c.id = cp.convo_id
      GROUP BY cp.user_id
    ) sub
    WHERE users.id = sub.user_id

The trigger should maintain it from there.
