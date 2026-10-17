-- Migration: 0016_oracle_submission_transitions
-- Legal transitions: submitted -> challenged|finalized|rejected; challenged -> finalized|rejected.

CREATE OR REPLACE FUNCTION enforce_oracle_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'submitted' AND NEW.status IN ('challenged', 'finalized', 'rejected')) OR
    (OLD.status = 'challenged' AND NEW.status IN ('finalized', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'illegal oracle_submission status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_oracle_submission_status_transition
BEFORE UPDATE OF status ON oracle_submissions
FOR EACH ROW EXECUTE FUNCTION enforce_oracle_submission_transition();
