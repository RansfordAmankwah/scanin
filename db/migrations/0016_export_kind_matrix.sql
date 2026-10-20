-- The course-wide attendance grid is a new export kind. Allow it in export_records.report_kind.
ALTER TYPE export_kind ADD VALUE IF NOT EXISTS 'ATTENDANCE_MATRIX';
