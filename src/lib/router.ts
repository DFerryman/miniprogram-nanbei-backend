import { useEffect, useState } from 'react';

/** 基于 hash 的极简路由：#/portfolios、#/portfolios/<id>、#/about … */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}
