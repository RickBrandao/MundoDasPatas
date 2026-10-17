import { useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { CloseButton, Modal } from '../../components/Modal';
import { units } from '../../domain/format';
import { addSaleLine } from '../../domain/operations';
import { activeProducts } from '../../domain/reports';
import type { SaleItem } from '../../domain/types';
import { productName } from '../admin/productName';

export function SaleModal({ onClose }: { onClose: () => void }) {
  const { data, actions } = useStore();
  const toast = useToast();
  const [lines, setLines] = useState<SaleItem[]>([]);
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const options = activeProducts(data.products)
    .filter((p) => p.stock > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const addLine = () => {
    const r = addSaleLine(data, lines, pick, qty);
    if (!r.ok) return setError(r.error);
    setLines(r.value);
    setPick('');
    setQty('1');
    setError('');
  };

  const confirmSale = async () => {
    if (saving) return; // evita registro duplicado por clique duplo
    setSaving(true);
    const r = await actions.registerSale(lines);
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onClose();
    toast(`Venda ${r.sale.id} registrada. Estoque atualizado.`);
  };

  return (
    <Modal label="Registrar venda" onClose={onClose} className="dialog dialog--padded" style={{ maxWidth: 600 }}>
      <div className="dialog-head">
        <div>
          <h2 className="dialog-title">Registrar venda</h2>
          <div className="dialog-sub">Use apenas para vendas concluídas. O estoque é reduzido ao confirmar.</div>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className="sale-picker">
        <label className="field sale-picker__product">
          Produto
          <select
            className="select"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              setError('');
            }}
          >
            <option value="">Selecione um produto</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.stock} em estoque
              </option>
            ))}
          </select>
        </label>
        <label className="field sale-picker__qty">
          Qtd.
          <input
            className="input"
            style={{ padding: '0 12px' }}
            value={qty}
            onChange={(e) => {
              setQty(e.target.value);
              setError('');
            }}
            inputMode="numeric"
          />
        </label>
        <button type="button" className="btn btn--teal btn--md sale-picker__add" style={{ padding: '0 16px' }} onClick={addLine}>
          Adicionar
        </button>
      </div>

      {error && (
        <div role="alert" className="alert alert--danger">
          {error}
        </div>
      )}

      <div className="sale-lines">
        {lines.length ? (
          <>
            {lines.map((l, i) => (
              <div key={l.productId} className="sale-lines__row">
                <span className="sale-lines__name">{productName(data, l.productId)}</span>
                <span style={{ fontWeight: 800 }}>{l.qty} un.</span>
                <button type="button" className="cart-line__remove" aria-label="Remover item" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <span aria-hidden="true" className="icon" style={{ fontSize: 22 }}>
                    delete
                  </span>
                </button>
              </div>
            ))}
            <div className="sale-lines__total">Total: {units(lines.reduce((a, l) => a + l.qty, 0))}</div>
          </>
        ) : (
          <div className="sale-lines__empty">Nenhum item adicionado.</div>
        )}
      </div>

      <div className="dialog-actions">
        <button type="button" className="btn btn--secondary btn--md" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn--primary btn--md" style={{ padding: '0 22px' }} onClick={confirmSale} disabled={saving}>
          Confirmar venda
        </button>
      </div>
    </Modal>
  );
}
