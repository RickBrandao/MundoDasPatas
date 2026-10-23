import { useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { useIdempotencyKeys } from '../../app/useIdempotencyKeys';
import { CloseButton, Modal } from '../../components/Modal';
import { isNonNegativeIntString } from '../../domain/format';

interface Props {
  productId: string;
  initialType: 'entrada' | 'ajuste';
  onClose: () => void;
}

export function StockMoveModal({ productId, initialType, onClose }: Props) {
  const { data, actions } = useStore();
  const toast = useToast();
  const [type, setType] = useState(initialType);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Uma chave por movimentação (tipo, quantidade, motivo): a nova tentativa não lança duas vezes.
  const keys = useIdempotencyKeys();
  const p = data.products.find((x) => x.id === productId);
  if (!p) return null;

  const preview = isNonNegativeIntString(qty) ? `Estoque após a operação: ${type === 'entrada' ? p.stock + parseInt(qty, 10) : parseInt(qty, 10)} un.` : '';

  const save = async () => {
    if (saving) return; // evita lançamento duplicado por clique duplo
    setSaving(true);
    const intent = JSON.stringify([productId, type, qty.trim(), note.trim()]);
    const r = await actions.moveStock({ productId, type, qty, note }, { idempotencyKey: keys.keyFor(intent) });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    keys.done(intent);
    onClose();
    toast(`Estoque atualizado: ${r.product.name} agora tem ${r.product.stock} un.`);
  };

  return (
    <Modal label="Movimentar estoque" onClose={onClose} className="dialog dialog--padded" style={{ maxWidth: 480 }}>
      <div className="dialog-head">
        <div>
          <h2 className="dialog-title">Movimentar estoque</h2>
          <div className="dialog-sub" style={{ color: 'var(--c-text-2)' }}>
            {p.name}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="sm-current">
        <span>
          Atual: <strong>{p.stock} un.</strong>
        </span>
        <span style={{ color: 'var(--c-muted-2)' }}>mínimo {p.minStock}</span>
      </div>
      <div role="group" aria-label="Tipo" className="segmented">
        {(['entrada', 'ajuste'] as const).map((t) => (
          <button
            type="button"
            key={t}
            aria-pressed={type === t}
            onClick={() => {
              setType(t);
              setError('');
            }}
          >
            {t === 'entrada' ? 'Entrada' : 'Ajuste'}
          </button>
        ))}
      </div>
      <form
        noValidate
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          {type === 'entrada' ? 'Quantidade recebida' : 'Nova quantidade em estoque (contagem)'}
          <input
            className="input"
            value={qty}
            onChange={(e) => {
              setQty(e.target.value);
              setError('');
            }}
            inputMode="numeric"
            placeholder="0"
          />
        </label>
        <label className="field">
          Motivo ou observação
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: reposição do fornecedor, avaria, contagem" />
        </label>
        {preview && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-teal-dark)' }}>{preview}</div>}
        {error && (
          <div role="alert" className="alert alert--danger">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn--secondary btn--md" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary btn--md" style={{ padding: '0 22px' }} disabled={saving} aria-busy={saving}>
            {saving ? 'Salvando…' : 'Confirmar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
