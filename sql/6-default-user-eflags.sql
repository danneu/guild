-- Users default to all email notification flags enabled
-- They don't receive email notifications until they verify their email
-- where they can uncheck flags.
ALTER TABLE users ALTER COLUMN eflags SET DEFAULT B'111111'::int;