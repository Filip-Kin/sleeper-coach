// Every path the coach reads or writes on the state volume, in one place, with
// one rule: under `bun test` (NODE_ENV=test) nothing points at production. On
// 2026-09-19 a test run inside the container wrote fixtures into the real
// activity log, and a real FREEZE broke four tests; the audit found the DB and
// token paths were still unguarded.

export const UNDER_TEST = process.env.NODE_ENV === "test";
const PROD_DIR = "/data/sleeper-coach";
const TEST_DIR = "/tmp/sleeper-coach-test";

export const STATE_DIR = process.env.COACH_STATE ?? process.env.STATE_DIR ?? (UNDER_TEST ? TEST_DIR : PROD_DIR);
export const DB_PATH = process.env.COACH_DB ?? `${STATE_DIR}/coach.db`;
export const FREEZE_FILE = process.env.COACH_FREEZE_FILE ?? `${STATE_DIR}/FREEZE`;
export const TOKEN_FILE = process.env.COACH_TOKEN_FILE ?? `${STATE_DIR}/sleeper-token`;
export const DRAFT_LOCK = `${STATE_DIR}/draft-active`;
export const KICKOFF_CACHE = `${STATE_DIR}/pickem-kickoffs.json`;
export const ACTIVITY_LOG = process.env.ACTIVITY_LOG ?? `${STATE_DIR}/activity.jsonl`;
export const REASONING_LOG = process.env.REASONING_LOG ?? `${STATE_DIR}/reasoning.jsonl`;
export const HEARTBEAT_FILE = `${STATE_DIR}/heartbeat`;
