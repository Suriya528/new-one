import { useState, useEffect, useCallback, useRef } from 'react';
import {
  api,
  type MetaResponse,
  type KpiDefinition,
  type SimulationResponse,
  type SavedScenario,
} from './api';

export function useModelMetadata() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [kpis, setKpis] = useState<KpiDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([api.getMeta(), api.getKpis()])
      .then(([m, k]) => {
        setMeta(m);
        setKpis(k);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { meta, kpis, loading, error, reload };
}

export function useSimulation(levers: Record<string, number>, enabled: boolean) {
  const [data, setData] = useState<SimulationResponse | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    const requestSeq = ++seqRef.current;
    setSimulating(true);

    timerRef.current = setTimeout(() => {
      api
        .simulate(levers)
        .then((res) => {
          if (requestSeq !== seqRef.current) return;
          setData(res);
          setSimError(null);
          setSimulating(false);
        })
        .catch((err: Error) => {
          if (requestSeq !== seqRef.current) return;
          setSimError(err.message);
          setSimulating(false);
        });
    }, 120);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [levers, enabled]);

  return { data, simulating, simError };
}

export function useScenarios() {
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .getScenarios()
      .then((list) => {
        setScenarios(list);
        setError(null);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveScenario = useCallback(
    async (name: string, description: string, levers: Record<string, number>) => {
      const created = await api.createScenario(name, description, levers);
      refresh();
      return created;
    },
    [refresh]
  );

  const deleteScenario = useCallback(
    async (id: number) => {
      await api.deleteScenario(id);
      refresh();
    },
    [refresh]
  );

  return { scenarios, loading, error, refresh, saveScenario, deleteScenario };
}
