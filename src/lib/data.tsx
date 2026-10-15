import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Portfolio, Series } from '../../shared/types.ts';
import { api, errorText } from './api.ts';

interface DataState {
  portfolios: Portfolio[];
  series: Series[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  upsertPortfolio: (p: Portfolio) => void;
  removePortfolio: (id: string) => void;
}

const Ctx = createContext<DataState | null>(null);

/** 作品与系列列表：进入后台时从当前环境加载一次，编辑后就地更新。 */
export function DataProvider({ sessionKey, children }: { sessionKey: string; children: ReactNode }) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
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
