import { useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { pluralize } from '../../domain/format';
import { activeProducts } from '../../domain/reports';
import { useAdminUi } from '../admin/adminContext';

export function CategoriesPage() {
  const { data, actions } = useStore();
  const ui = useAdminUi();
  const toast = useToast();
  const act = activeProducts(data.products);
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <div className="admin-page" data-screen-label="Admin · Categorias">
      <div className="admin-toolbar admin-toolbar--split">
        <p className="admin-lead" style={{ maxWidth: '36em' }}>
          Categorias inativas e seus produtos não aparecem no catálogo nem nos filtros.
        </p>
        <button type="button" className="btn btn--primary btn--md" style={{ fontSize: 15 }} onClick={() => ui.openCategoryForm(null)}>
          <Icon name="add" size={22} />
          Nova categoria
        </button>
      </div>
      {data.categories.length === 0 && (
        <div className="admin-empty">
          <div className="admin-empty__title">Nenhuma categoria cadastrada</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>Cadastre a primeira categoria para começar a organizar o catálogo.</div>
        </div>
      )}
      <div className="cat-admin-grid">
        {data.categories.map((c) => {
          const n = act.filter((p) => p.categoryId === c.id).length;
          return (
            <div key={c.id} className="cat-admin">
              <div className="cat-admin__top">
                <span className="cat-admin__icon">
                  <Icon name={c.icon || 'label'} size={24} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cat-admin__name">{c.name}</div>
                  <div className="cat-admin__count">{pluralize(n, 'produto', 'produtos')}</div>
                </div>
                <span className={`badge ${c.active ? 'tone-ok' : 'tone-muted'}`}>{c.active ? 'Ativa' : 'Inativa'}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn--secondary btn--grow" onClick={() => ui.openCategoryForm(c)}>
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--grow"
                  disabled={busy === c.id}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(c.id);
                    const r = await actions.toggleCategory(c.id);
                    setBusy(null);
                    if (!r.ok) return toast(r.error);
                    toast(r.active ? 'Categoria ativada.' : 'Categoria desativada. Os produtos dela saem do catálogo.');
                  }}
                >
                  {c.active ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
