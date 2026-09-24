-- Migration: 0015_oracle_updated_at

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

ALTER TABLE oracle_submissions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE oracle_disputes ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TRIGGER trg_oracle_submissions_updated_at
BEFORE UPDATE ON oracle_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_oracle_disputes_updated_at
BEFORE UPDATE ON oracle_disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
