import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import type { StoreData } from '../domain/types';
import type { DashboardSummary } from '../services/http/adapters';
import { ApiRequestError, failureMessage } from '../services/http/apiClient';
import type { ApiResult, StoreApi } from '../services/storeApi';
import { StoreContext, type StoreActions, type StoreContextValue } from './contexts';

interface Props {
  api: StoreApi;
  children: ReactNode;
}

interface Snapshot {
  data: StoreData;
  dashboard?: DashboardSummary;
}

/** Horário do último carregamento bem-sucedido de cada origem (para `refresh(maxAgeMs)`). */
const loadedAt = new WeakMap<StoreApi, number>();

const loadErrorMessage = (api: StoreApi, error: unknown) => {
  const what = api.source === 'api-admin' ? 'os dados do painel' : api.source === 'api-public' ? 'o catálogo' : 'os dados da loja';
  const detail = error instanceof ApiRequestError ? ` ${failureMessage(error.failure)}` : '';
  return `Não foi possível carregar ${what}.${detail}`;
};

/**
 * Carrega os dados pelo `StoreApi` e expõe o estado e as ações para a interface.
 * Com a API, uma falha de carregamento mostra o erro e a opção de tentar de novo — nunca
 * troca para os dados locais.
 */
export function StoreProvider({ api, children }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [storageFail, setStorageFail] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .load()
      .then((r) => {
        if (!alive) return;
        loadedAt.set(api, Date.now());
        setSnapshot({ data: r.data, dashboard: r.dashboard });
        setPersistent(r.persistent);
        setLoadError(null);
      })
      .catch((error: unknown) => alive && setLoadError(loadErrorMessage(api, error)));
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  // Depois de desmontado (ex.: logout no painel) as atualizações são simplesmente descartadas pelo React.
  const accept = useCallback(
    (data: StoreData, dashboard?: DashboardSummary) => {
      loadedAt.set(api, Date.now());
      setSnapshot((s) => ({ data, dashboard: dashboard ?? s?.dashboard }));
    },
    [api],
  );

  const actions = useMemo<StoreActions>(() => {
    const apply = async <R extends ApiResult<object>>(p: Promise<R>): Promise<R> => {
      const r = await p;
      if (r.ok) {
        accept(r.data, r.dashboard);
        setStorageFail(!r.persisted);
        setStale(!!r.stale);
      } else if (r.refreshed) {
        accept(r.refreshed.data, r.refreshed.dashboard);
        setStale(false);
      }
      return r;
    };
    return {
      saveProduct: (i) => apply(api.saveProduct(i)),
      patchProduct: (id, f) => apply(api.patchProduct(id, f)),
      moveStock: (i, o) => apply(api.moveStock(i, o)),
      registerSale: (items, o) => apply(api.registerSale(items, o)),
      cancelSale: (id, o) => apply(api.cancelSale(id, o)),
      saveCategory: (i) => apply(api.saveCategory(i)),
      toggleCategory: (id) => apply(api.toggleCategory(id)),
      saveSettings: (s) => apply(api.saveSettings(s)),
      resetDemo: () => apply(api.resetDemo()),
      refresh: async (maxAgeMs = 0) => {
        if (maxAgeMs > 0 && Date.now() - (loadedAt.get(api) ?? 0) < maxAgeMs) return;
        try {
          const r = await api.load();
          accept(r.data, r.dashboard);
          setStale(false);
        } catch {
          // Mantém o estado atual; o próximo carregamento ou operação mostra o erro.
        }
      },
    };
  }, [api, accept]);

  const value = useMemo<StoreContextValue | null>(
    () =>
      snapshot
        ? { data: snapshot.data, dashboard: snapshot.dashboard, source: api.source, stale, storageFail, persistent, actions }
        : null,
    [snapshot, api.source, stale, storageFail, persistent, actions],
  );

  if (loadError && !value) {
    return (
      <div role="alert" className="app-loading app-loading--error">
        <p>{loadError}</p>
        {api.source !== 'local' && (
          <button
            type="button"
            className="btn btn--primary btn--md"
            onClick={() => {
              setLoadError(null);
              setAttempt((n) => n + 1);
            }}
          >
            <Icon name="refresh" />
            Tentar novamente
          </button>
        )}
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
