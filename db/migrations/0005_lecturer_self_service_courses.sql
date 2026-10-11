-- Lecturers can create their own terms and courses. The application database role still has no
-- INSERT privilege on terms, courses or lecturer_courses: it can only call the two functions below,
-- which create exactly "a term owned by this lecturer" and "a course this lecturer is assigned to".
--
-- Terms created by a lecturer are private to them (created_by is set), so one lecturer cannot take
-- another's term name or change the dates that drive another lecturer's retention. Terms created by
-- the operator (created_by IS NULL) stay shared and are unique by name, as before.
ALTER TABLE terms ADD COLUMN created_by uuid REFERENCES users (id);
ALTER TABLE terms DROP CONSTRAINT terms_name_key;
CREATE UNIQUE INDEX terms_shared_name_key ON terms (name) WHERE created_by IS NULL;
CREATE UNIQUE INDEX terms_owned_name_key ON terms (created_by, name) WHERE created_by IS NOT NULL;

-- Error codes are the SQLSTATE 'SC001' with the reason as the message, so callers can map them.
CREATE FUNCTION create_term_for_lecturer(
  p_lecturer uuid, p_name text, p_starts date, p_ends date
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name text := btrim(p_name);
  v_id uuid;
BEGIN
  PERFORM 1 FROM users WHERE id = p_lecturer AND role = 'LECTURER' AND status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_A_LECTURER' USING ERRCODE = 'SC001';
  END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 100
     OR p_starts IS NULL OR p_ends IS NULL
     OR p_ends <= p_starts
     OR p_ends - p_starts > 400               -- a term, not an open-ended course of study
     OR p_ends > current_date + 730 THEN      -- retention is end date + 1 year: bound how far out
    RAISE EXCEPTION 'INVALID_TERM' USING ERRCODE = 'SC001';
  END IF;
  INSERT INTO terms (name, starts_on, ends_on, created_by)
  VALUES (v_name, p_starts, p_ends, p_lecturer) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION create_course_for_lecturer(
  p_lecturer uuid, p_term uuid, p_code text, p_title text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_code text := btrim(p_code);
  v_title text := btrim(p_title);
  v_id uuid;
BEGIN
  PERFORM 1 FROM users WHERE id = p_lecturer AND role = 'LECTURER' AND status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_A_LECTURER' USING ERRCODE = 'SC001';
  END IF;
  -- Only an operator-created (shared) term or one this lecturer created.
  PERFORM 1 FROM terms WHERE id = p_term AND (created_by IS NULL OR created_by = p_lecturer);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TERM_NOT_FOUND' USING ERRCODE = 'SC001';
  END IF;
  IF v_code IS NULL OR length(v_code) NOT BETWEEN 1 AND 32
     OR v_title IS NULL OR length(v_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'INVALID_COURSE' USING ERRCODE = 'SC001';
  END IF;
  INSERT INTO courses (term_id, code, title) VALUES (p_term, v_code, v_title) RETURNING id INTO v_id;
  INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES (v_id, p_lecturer);
  RETURN v_id;
END $$;

-- Functions are executable by everyone unless revoked.
REVOKE ALL ON FUNCTION create_term_for_lecturer(uuid, text, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_course_for_lecturer(uuid, uuid, text, text) FROM PUBLIC;
