-- Showcase SQL Query: Complete KPI Lineage, Dependencies, Lag, FY Rule, Actual Baseline, and Guardrails
-- Demonstrates relational modeling of company-data.json in SQLite.

SELECT
  kd.sort_order AS "#",
  kd.id AS kpi_id,
  kd.label,
  kd.kind,
  kd.unit,
  kd.fy_rule,
  CASE WHEN kd.is_lever = 1 THEN 'YES' ELSE 'NO' END AS lever,
  kd.effective_from_month AS eff_from_m,
  COALESCE(kd.op, 'input') AS formula_op,
  COALESCE(
    GROUP_CONCAT(
      CASE
        WHEN dep.depends_on_kpi_id IS NOT NULL THEN
          dep.depends_on_kpi_id ||
          CASE WHEN dep.lag > 0 THEN '(t-' || dep.lag || ')' ELSE '(t)' END ||
          CASE WHEN dep.dependency_role = 'reacts_to' THEN '[elast=' || dep.elasticity || ']' ELSE '' END
        WHEN dep.const_value IS NOT NULL THEN 'const(' || dep.const_value || ')'
        ELSE NULL
      END,
      ' , '
    ),
    '(none)'
  ) AS dependencies,
  MAX(dep.lag) AS max_lag,
  ROUND(
    CASE kd.fy_rule
      WHEN 'sum' THEN (SELECT SUM(ma.value) FROM monthly_actuals ma WHERE ma.kpi_id = kd.id)
      WHEN 'mean' THEN (SELECT AVG(ma.value) FROM monthly_actuals ma WHERE ma.kpi_id = kd.id)
      WHEN 'last' THEN (SELECT ma.value FROM monthly_actuals ma WHERE ma.kpi_id = kd.id AND ma.month_index = 12)
      ELSE NULL
    END,
    2
  ) AS fy_input_baseline,
  COALESCE(
    (SELECT GROUP_CONCAT(g.label || ' [' || g.scope || ']', '; ')
     FROM guardrails g WHERE g.kpi_id = kd.id),
    '-'
  ) AS bank_guardrails
FROM kpi_definitions kd
LEFT JOIN kpi_dependencies dep ON dep.kpi_id = kd.id
GROUP BY kd.id
ORDER BY kd.sort_order;
