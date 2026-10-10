-- Least privilege for self-registration: the application role may only insert the columns a student
-- sign-up needs (see grants.sql), so it can never choose a role or pre-verify an e-mail address.
-- Omitting `role` therefore yields a student; lecturers are created by the operator, who names the
-- role explicitly.
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'STUDENT';
