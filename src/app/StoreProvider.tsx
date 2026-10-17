import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StoreData } from '../domain/types';
import type { ApiResult, StoreApi } from '../services/storeApi';
import { StoreContext, type StoreActions, type StoreContextValue } from './contexts';

interface Props {
  api: StoreApi;
  children: ReactNode;
}

/** Carrega os dados pelo `StoreApi` e expõe o estado e as ações para a interface. */
export function StoreProvider({ api, children }: Props) {
  const [data, setData] = useState<StoreData | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [storageFail, setStorageFail] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .load()
      .then((r) => {
        if (!alive) return;
        setData(r.data);
        setPersistent(r.persistent);
      })
      .catch(() => alive && setLoadError('Não foi possível carregar os dados da loja.'));
    return () => {
      alive = false;
    };
  }, [api]);

  const actions = useMemo<StoreActions>(() => {
    const apply = async <R extends ApiResult<object>>(p: Promise<R>): Promise<R> => {
      const r = await p;
      if (r.ok) {
        setData(r.data);
        setStorageFail(!r.persisted);
      }
      return r;
    };
    return {
      saveProduct: (i) => apply(api.saveProduct(i)),
      patchProduct: (id, f) => apply(api.patchProduct(id, f)),
      moveStock: (i) => apply(api.moveStock(i)),
      registerSale: (items) => apply(api.registerSale(items)),
      cancelSale: (id) => apply(api.cancelSale(id)),
      saveCategory: (i) => apply(api.saveCategory(i)),
      toggleCategory: (id) => apply(api.toggleCategory(id)),
      saveSettings: (s) => apply(api.saveSettings(s)),
      resetDemo: () => apply(api.resetDemo()),
    };
  }, [api]);

  const value = useMemo<StoreContextValue | null>(
    () => (data ? { data, storageFail, persistent, actions } : null),
    [data, storageFail, persistent, actions],
  );

  if (loadError) {
    return (
      <div role="alert" className="app-loading">
        {loadError}
      </div>
    );
  }
  if (!value) {
    return (
      <div className="app-loading" aria-busy="true">
        Carregando…
      </div>
    );
  }
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
