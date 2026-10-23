import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart, useConfirm, useStore, useToast } from '../../app/contexts';
import { Field } from '../../components/Field';
import type { FieldErrors, Settings } from '../../domain/types';
import { runSelfChecks } from './selfChecks';

export function SettingsPage() {
  const { data, actions, source } = useStore();
  const remote = source === 'api-admin';
  const { clear } = useCart();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // Rascunho: só vale ao clicar em "Salvar configurações", como no protótipo.
  const [draft, setDraft] = useState<Settings>(() => ({ ...data.settings }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const checks = useMemo(() => runSelfChecks(), []);
  const passed = checks.filter((c) => c.pass).length;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const r = await actions.saveSettings(draft);
    setSaving(false);
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return toast(r.error);
    }
    setDraft({ ...r.data.settings });
    setErrors({});
    toast(r.persisted ? 'Configurações salvas. O site já reflete as mudanças.' : 'Aplicado nesta sessão, mas não foi possível salvar no navegador.');
  };

  const reset = async () => {
    const yes = await confirm({
      title: 'Restaurar dados de demonstração?',
      text: 'Produtos, estoque, vendas e configurações voltam ao estado inicial. As alterações feitas nesta demonstração serão perdidas.',
      ok: 'Restaurar',
      danger: true,
    });
    if (!yes) return;
    const r = await actions.resetDemo();
    if (!r.ok) return toast(r.error);
    clear();
    navigate('/admin/visao-geral');
    toast('Dados de demonstração restaurados.');
  };

  const text = (k: 'storeName' | 'address' | 'hours', label: string, full = false) => (
    <Field label={label} full={full} error={errors[k]} errorId={`set-${k}-err`}>
      <input className="input" value={draft[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} aria-describedby={errors[k] ? `set-${k}-err` : undefined} />
    </Field>
  );

  return (
    <div className="admin-page settings" data-screen-label="Admin · Configurações">
      <form
        noValidate
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="panel panel--form">
          <h2 className="panel-title">Dados da loja</h2>
          <div className="form-grid">
            {text('storeName', 'Nome da loja')}
            <Field
              label="WhatsApp comercial"
              hint={
                <span className="field-hint" id="wa-hint">
                  DDD + número, com ou sem +55.
                </span>
              }
              error={errors.whatsapp}
              errorId="wa-err"
            >
              <input
                className="input"
                value={draft.whatsapp}
                onChange={(e) => set('whatsapp', e.target.value)}
                inputMode="tel"
                aria-invalid={!!errors.whatsapp}
                aria-describedby={errors.whatsapp ? 'wa-hint wa-err' : 'wa-hint'}
              />
            </Field>
            {text('address', 'Endereço', true)}
            {text('hours', 'Horário de funcionamento', true)}
            <label className="field field--full">
              Sobre nós (texto institucional)
              <textarea className="textarea" value={draft.about} onChange={(e) => set('about', e.target.value)} rows={5} />
            </label>
          </div>
        </section>

        <section className="panel panel--form" style={{ gap: 4 }}>
          <h2 className="panel-title" style={{ marginBottom: 8 }}>
            Exibição do catálogo
          </h2>
          <label className="check">
            <input type="checkbox" checked={draft.showOutOfStock} onChange={(e) => set('showOutOfStock', e.target.checked)} />
            Mostrar produtos esgotados (com aviso de indisponível)
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.showFeatured} onChange={(e) => set('showFeatured', e.target.checked)} />
            Exibir a seção de destaques na página inicial
          </label>
        </section>

        <div className="admin-toolbar admin-toolbar--split">
          {remote ? (
            <span />
          ) : (
            <button type="button" className="btn btn--danger btn--md" style={{ padding: '0 16px' }} onClick={reset}>
              Restaurar dados de demonstração
            </button>
          )}
          <button type="submit" className="btn btn--primary btn--md" style={{ fontSize: 15, padding: '0 22px' }} disabled={saving}>
            Salvar configurações
          </button>
        </div>
      </form>

      {remote ? (
        <div className="notice notice--info">
          As configurações ficam gravadas no servidor e valem para todos os acessos ao catálogo. Enquanto não forem salvas pela primeira vez, a loja usa os valores padrão (sem
          número de WhatsApp).
        </div>
      ) : (
        <div className="notice notice--info">
          Nesta demonstração os dados ficam salvos apenas neste navegador (armazenamento local, limitado a poucos MB). Fotos enviadas são comprimidas, mas muitas imagens podem esgotar o
          espaço; na versão final elas irão para o armazenamento em nuvem. Nenhuma credencial é solicitada ou armazenada.
        </div>
      )}

      <section className="panel panel--form" style={{ gap: 10 }}>
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <h2 className="panel-title">Testes de regressão (preço e WhatsApp)</h2>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--c-teal-dark)' }}>
            {passed} de {checks.length} aprovados
          </span>
        </div>
        <div className="stack-0">
          {checks.map((c) => (
            <div key={c.name} className="check-row">
              <span className={`check-row__tag ${c.pass ? 'tone-ok' : 'tone-out'}`}>{c.pass ? 'PASS' : 'FAIL'}</span>
              <span style={{ minWidth: 0 }}>{c.name}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
