import { useStore, useToast, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { CloseButton, Modal } from '../../components/Modal';
import { asset } from '../../components/productArt';
import { buildWhatsAppLink, openWhatsApp, WHATSAPP_REDIRECT_ENABLED } from '../../domain/whatsapp';

/**
 * Encomenda pelo WhatsApp em dois passos: (1) revisar/editar a mensagem; (2) prévia simulada.
 * Na demo nada é enviado. Nenhuma venda é registrada a partir daqui.
 */
export function WhatsAppModal() {
  const { data } = useStore();
  const { wa, setWa, setCartOpen } = useUi();
  const toast = useToast();
  if (!wa) return null;

  const { storeName, whatsapp } = data.settings;
  const link = buildWhatsAppLink(whatsapp, wa.text);
  const close = () => setWa(null);

  const goPreview = () => {
    if (!link.ok) return toast('Número de WhatsApp da loja inválido. Corrija em Configurações.');
    if (!wa.text.trim()) return toast('A mensagem não pode ficar vazia.');
    setWa({ ...wa, step: 2 });
  };
  const finish = () => {
    const opened = link.ok && openWhatsApp(link.url);
    setWa(null);
    setCartOpen(false);
    toast(opened ? 'WhatsApp aberto em outra aba.' : 'Simulação concluída. Nenhuma mensagem foi enviada.');
  };

  return (
    <Modal label="Encomendar pelo WhatsApp" onClose={close} className="dialog wa-dialog">
      <div className="wa-dialog__head">
        <span className="wa-dialog__badge">
          <Icon name="chat" size={24} />
        </span>
        <h2 className="dialog-title" style={{ flex: 1 }}>
          {wa.step === 1 ? 'Sua mensagem para a loja' : 'Simulação do WhatsApp'}
        </h2>
        <CloseButton onClick={close} />
      </div>

      {wa.step === 1 ? (
        <div className="wa-dialog__body">
          <p className="wa-dialog__intro">Revise a mensagem. Você pode editar aqui ou no próprio WhatsApp antes de enviar.</p>
          <textarea className="textarea wa-dialog__text" value={wa.text} onChange={(e) => setWa({ ...wa, text: e.target.value })} rows={11} aria-label="Mensagem" />
          <div className="wa-dialog__to">
            Para:{' '}
            <strong>
              {storeName} · {whatsapp}
            </strong>
            <span className="wa-dialog__demo-tag">número demonstrativo</span>
          </div>
          {!link.ok && (
            <div role="alert" className="alert alert--danger">
              Número da loja inválido: {link.error} Corrija em Configurações.
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn--secondary btn--md" onClick={close}>
              Voltar
            </button>
            <button type="button" className="btn btn--primary btn--md wa-dialog__go" onClick={goPreview}>
              Visualizar envio (simulação)
              <Icon name="open_in_new" />
            </button>
          </div>
        </div>
      ) : (
        <div className="wa-dialog__body">
          <div className="wa-preview">
            <div className="wa-preview__bar">
              <span className="wa-preview__avatar">
                <img src={asset('assets/logo.png')} alt="" />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="wa-preview__name">{storeName}</div>
                <div className="wa-preview__phone">{whatsapp} · demonstrativo</div>
              </div>
            </div>
            <div className="wa-preview__chat">
              <div className="wa-preview__bubble">{wa.text}</div>
              <div className="wa-preview__hint">Rascunho — aguardando o cliente tocar em enviar</div>
            </div>
          </div>
          <div className="notice notice--warn" style={{ fontSize: 13, padding: '12px 14px', borderRadius: 12 }}>
            {WHATSAPP_REDIRECT_ENABLED ? (
              <strong>Ao concluir, o WhatsApp será aberto com a mensagem; o envio só acontece quando você confirmar.</strong>
            ) : (
              <>
                <strong>Demonstração: nenhuma mensagem foi enviada e o WhatsApp não foi aberto.</strong> Na versão final, o botão abrirá o WhatsApp com o link abaixo, e o envio só acontece
                quando o cliente confirma.
              </>
            )}{' '}
            A encomenda não é registrada como venda.
          </div>
          <div className="wa-url" aria-label="Link de envio">
            {link.ok ? link.url : ''}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn--secondary btn--md" onClick={() => setWa({ ...wa, step: 1 })}>
              Voltar e editar
            </button>
            <button type="button" className="btn btn--teal-solid btn--md wa-dialog__done" onClick={finish}>
              Concluir simulação
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
