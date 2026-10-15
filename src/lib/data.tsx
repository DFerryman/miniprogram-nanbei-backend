import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Portfolio, Series } from '../../shared/types.ts';
import { api, errorText } from './api.ts';
import { useRemoteChanges } from './collab.tsx';

interface DataState {
  portfolios: Portfolio[];
  series: Series[];
  loading: boolean;
  error: string;
  reload: (silent?: boolean) => Promise<void>;
  upsertPortfolio: (p: Portfolio) => void;
  removePortfolio: (id: string) => void;
}

const Ctx = createContext<DataState | null>(null);

/** 作品与系列列表：进入后台时加载，编辑后就地更新；其他窗口保存后自动静默刷新。 */
export function DataProvider({ sessionKey, children }: { sessionKey: string; children: ReactNode }) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [p, s] = await Promise.all([api.portfolios(), api.series()]);
      setPortfolios(p.items);
      setSeries(s.items);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortfolios([]);
    setSeries([]);
    reload();
  }, [sessionKey, reload]);

  const upsertPortfolio = useCallback((p: Portfolio) => {
    setPortfolios((list) => (list.some((x) => x._id === p._id) ? list.map((x) => (x._id === p._id ? p : x)) : [p, ...list]));
  }, []);

  // 合并短时间内的多条修改通知，只刷新一次
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRemoteChanges((c) => {
    if (c.kind !== 'portfolio' && c.kind !== 'series') return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void reload(true), 300);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const removePortfolio = useCallback((id: string) => setPortfolios((list) => list.filter((x) => x._id !== id)), []);

  return (
    <Ctx.Provider value={{ portfolios, series, loading, error, reload, upsertPortfolio, removePortfolio }}>
      {children}
    </Ctx.Provider>
  );
}

export function useData(): DataState {
  const v = useContext(Ctx);
  if (!v) throw new Error('DataProvider missing');
  return v;
}
