-- Migration 001: Profit What-If Simulator SQLite Schema
-- Normalized schema covering company metadata, KPIs, dependency DAG,
-- monthly historical actuals, scenario rules, bank guardrails, and persisted scenarios.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS scenario_sliders;
DROP TABLE IF EXISTS kpi_actuals;
DROP TABLE IF EXISTS reacts_to;
DROP TABLE IF EXISTS company;
DROP TABLE IF EXISTS scenario_results;
DROP TABLE IF EXISTS scenarios;
DROP TABLE IF EXISTS guardrails;
DROP TABLE IF EXISTS scenario_rules;
DROP TABLE IF EXISTS monthly_actuals;
DROP TABLE IF EXISTS kpi_dependencies;
DROP TABLE IF EXISTS kpi_definitions;
DROP TABLE IF EXISTS months;
DROP TABLE IF EXISTS company_meta;

PRAGMA foreign_keys = ON;

CREATE TABLE company_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company TEXT NOT NULL,
  currency_note TEXT NOT NULL,
  fiscal_year TEXT NOT NULL,
  month_index_note TEXT NOT NULL
);

CREATE TABLE months (
  month_index INTEGER PRIMARY KEY,
  month_label TEXT NOT NULL UNIQUE
);

CREATE TABLE kpi_definitions (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'formula')),
  unit TEXT NOT NULL CHECK (unit IN ('usd_k', 'usd', 'pct', 'count')),
  good_when TEXT NOT NULL CHECK (good_when IN ('up', 'down', 'neutral')),
  fy_rule TEXT NOT NULL CHECK (fy_rule IN ('sum', 'mean', 'last', 'recompute')),
  is_lever INTEGER NOT NULL DEFAULT 0 CHECK (is_lever IN (0, 1)),
  is_primary_lever INTEGER NOT NULL DEFAULT 0 CHECK (is_primary_lever IN (0, 1)),
  is_integer INTEGER NOT NULL DEFAULT 0 CHECK (is_integer IN (0, 1)),
  min_value REAL,
  max_value REAL,
  effective_from_month INTEGER NOT NULL DEFAULT 1,
  prior_value REAL,
  op TEXT,
  formula_json TEXT
);

CREATE TABLE kpi_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kpi_id TEXT NOT NULL,
  depends_on_kpi_id TEXT,
  dependency_role TEXT NOT NULL, -- 'num', 'den', 'factor', 'input', 'step_on', 'tax_base', 'reacts_to'
  lag INTEGER NOT NULL DEFAULT 0,
  sign REAL NOT NULL DEFAULT 1,
  const_value REAL,
  elasticity REAL,
  position_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (kpi_id) REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_kpi_id) REFERENCES kpi_definitions(id) ON DELETE CASCADE
);

CREATE TABLE monthly_actuals (
  kpi_id TEXT NOT NULL,
  month_index INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (kpi_id, month_index),
  FOREIGN KEY (kpi_id) REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (month_index) REFERENCES months(month_index) ON DELETE CASCADE
);

CREATE TABLE scenario_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('sliders', 'reacts_to', 'order', 'lag', 'fy_rule')),
  rule_key TEXT NOT NULL,
  source_kpi TEXT,
  target_kpi TEXT,
  elasticity REAL,
  execution_order INTEGER,
  description TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (source_kpi) REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (target_kpi) REFERENCES kpi_definitions(id) ON DELETE CASCADE
);

CREATE TABLE guardrails (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kpi_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('year', 'every_month')),
  min_value REAL,
  max_value REAL,
  FOREIGN KEY (kpi_id) REFERENCES kpi_definitions(id) ON DELETE CASCADE
);

CREATE TABLE scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  levers_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scenario_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL,
  kpi_id TEXT NOT NULL,
  fy_actual REAL NOT NULL,
  fy_scenario REAL NOT NULL,
  delta_abs REAL NOT NULL,
  delta_pct REAL,
  monthly_scenario_json TEXT NOT NULL,
  guardrail_passed INTEGER,
  UNIQUE (scenario_id, kpi_id),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  FOREIGN KEY (kpi_id) REFERENCES kpi_definitions(id) ON DELETE CASCADE
);
