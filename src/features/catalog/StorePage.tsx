import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { APP_CONFIG } from '../../app/config';
import { useCart, useStore, useUi } from '../../app/contexts';
import { scrollToSection } from '../../app/scroll';
import { Icon } from '../../components/Icon';
import { asset } from '../../components/productArt';
import { CATEGORY_TINT, DEFAULT_TINT } from '../../components/status';
import { DEFAULT_FILTERS, featuredProducts, visibleProducts, type CatalogFilters } from '../../domain/catalog';
import { pluralize } from '../../domain/format';
import { buildOrderMessage } from '../../domain/whatsapp';
import { CatalogSection } from './CatalogSection';
import { ProductCard } from './ProductCard';
import { NAV_LINKS, useOpenAdmin } from './navigation';
import { StoreHeader } from './StoreHeader';

const STEPS = [
  ['Escolha os produtos', 'Adicione itens e quantidades à sua encomenda. Não precisa de cadastro.'],
  ['Revise a mensagem', 'Montamos a mensagem com a sua lista. Você pode editá-la antes de enviar.'],
  ['Combine com a loja', 'Pelo WhatsApp, a loja confirma disponibilidade, entrega ou retirada e pagamento.'],
];

export function StorePage() {
  const { data } = useStore();
  const { count } = useCart();
  const { cartOpen, setCartOpen, setWa, goToSection } = useUi();
  const openAdmin = useOpenAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_FILTERS);
  const { settings } = data;

  // Navegação vinda do painel para uma seção específica.
  const pendingSection = (location.state as { section?: string } | null)?.section;
  useEffect(() => {
    if (!pendingSection) return;
    const t = setTimeout(() => scrollToSection(pendingSection), 80);
    navigate('.', { replace: true, state: null });
    return () => clearTimeout(t);
  }, [pendingSection, navigate]);

  const visible = useMemo(() => visibleProducts(data.products, data), [data]);
  const featured = useMemo(() => featuredProducts(data.products, data), [data]);
  const activeCats = data.categories.filter((c) => c.active);
  const openContactWa = () => setWa({ text: buildOrderMessage(settings.storeName, []), step: 1, fromCart: false });
  const showCartBar = count > 0 && !cartOpen;

  return (
    <div className="store" data-screen-label="Loja pública">
      <StoreHeader />

      <section id="inicio" className="hero">
        <div className="hero__text">
          <div className="hero__kicker">
            <Icon name="pets" size={18} />
            Rações · Petiscos · Brinquedos · Acessórios
          </div>
          <h1 className="hero__title">
            Tudo para o bem-estar do seu <span>melhor amigo!</span>
          </h1>
          <p className="hero__lead">Rações, brinquedos, acessórios e muito carinho para quem faz parte da sua família.</p>
          <div className="hero__actions">
            <button type="button" className="btn btn--primary btn--pill btn--lg hero__cta" onClick={() => goToSection('produtos')}>
              Explorar Produtos
              <Icon name="arrow_downward" />
            </button>
            <button type="button" className="btn btn--teal btn--pill btn--lg hero__wa" onClick={openContactWa}>
              <Icon name="chat" />
              Falar pelo WhatsApp
            </button>
          </div>
          <div className="hero__perks">
            {['Sem cadastro', 'Encomenda pelo WhatsApp', 'Entrega ou retirada combinada'].map((t) => (
              <span key={t}>
                <Icon name="check_circle" size={18} />
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="hero__visual">
          {APP_CONFIG.heroVisual === 'banner' ? (
            <div className="hero__banner">
              <img src={asset('assets/banner.jpeg')} alt="Logotipo Mundo das Patas com gato e cachorro ilustrados" width={1600} height={685} />
            </div>
          ) : (
            <div className="hero__logo-circle">
              <div>
                <img src={asset('assets/logo.png')} alt="Mundo das Patas" />
              </div>
            </div>
          )}
        </div>
      </section>

      <section id="categorias" className="section section--cats">
        <div className="section-title">
          <span className="eyebrow">Categorias</span>
          <h2>Encontre o que seu pet precisa</h2>
        </div>
        <div className="cat-grid">
          {activeCats.map((c) => {
            const n = visible.filter((p) => p.categoryId === c.id).length;
            return (
              <button
                type="button"
                key={c.id}
                className="cat-card"
                style={{ background: CATEGORY_TINT[c.id] ?? DEFAULT_TINT }}
                onClick={() => {
                  setFilters((f) => ({ ...f, categoryId: c.id, q: '' }));
                  goToSection('produtos');
                }}
              >
                <span className="cat-card__icon">
                  <Icon name={c.icon || 'label'} size={28} />
                </span>
                <span className="cat-card__text">
                  <span className="cat-card__name">{c.name}</span>
                  <span className="cat-card__count">{pluralize(n, 'produto', 'produtos')}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {featured.length > 0 && (
        <section id="destaques" className="band">
          <div className="band__inner">
            <div className="section-head section-head--split">
              <div className="section-title">
                <span className="eyebrow">Destaques</span>
                <h2>Os queridinhos da loja</h2>
              </div>
              <button type="button" className="btn btn--link" style={{ fontSize: 15, gap: 4 }} onClick={() => goToSection('produtos')}>
                Ver catálogo completo
                <Icon name="arrow_forward" />
              </button>
            </div>
            <div className="product-grid" style={{ marginTop: 24 }}>
              {featured.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="section section--steps">
        <div className="section-title">
          <span className="eyebrow">Como funciona</span>
          <h2>Sua encomenda em três passos</h2>
        </div>
        <ol className="steps">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="info-card">
              <span className="steps__num">{i + 1}</span>
              <div>
                <div className="steps__title">{title}</div>
                <div className="steps__text">{text}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <CatalogSection filters={filters} onChange={setFilters} />

      <section id="sobre" className="band band--about">
        <div className="about">
          <AboutArt />
          <div className="about__text">
            <span className="eyebrow">Sobre nós</span>
            <h2 className="section-h2">Feito por quem ama bicho</h2>
            <p className="about__body">{settings.about}</p>
            <span className="about__tag">Texto demonstrativo · editável em Configurações</span>
          </div>
        </div>
      </section>

      <section id="contato" className="section section--contact">
        <div className="section-title">
          <span className="eyebrow">Contato</span>
          <h2>Fale com a gente</h2>
        </div>
        <div className="contact-grid">
          <ContactCard icon="chat" tone="tone-ok" label="WhatsApp" note="Número demonstrativo">
            <div className="contact-card__value contact-card__value--big">{settings.whatsapp}</div>
          </ContactCard>
          <ContactCard icon="location_on" tone="tone-peach" label="Endereço" note="Endereço demonstrativo">
            <div className="contact-card__value">{settings.address}</div>
          </ContactCard>
          <ContactCard icon="schedule" tone="tone-brown" label="Horário" note="Horário demonstrativo">
            <div className="contact-card__value">{settings.hours}</div>
          </ContactCard>
        </div>
        <div className="contact-cta">
          <div style={{ minWidth: 0 }}>
            <div className="contact-cta__title">Ficou com alguma dúvida?</div>
            <div className="contact-cta__text">Chame no WhatsApp e a equipe responde.</div>
          </div>
          <button type="button" className="btn btn--lg btn--pill contact-cta__btn" onClick={openContactWa}>
            <Icon name="chat" size={22} />
            Falar pelo WhatsApp
          </button>
        </div>
      </section>

      <footer className="footer">
        <div className="footer__grid">
          <div className="footer__brand">
            <div className="footer__logo">
              <img src={asset('assets/logo.png')} alt="Mundo das Patas" />
            </div>
            <div className="footer__muted">Produtos para cães e gatos com atendimento pelo WhatsApp.</div>
          </div>
          <div className="footer__col footer__col--nav">
            <div className="footer__heading">Navegação</div>
            {NAV_LINKS.map(([label, id]) => (
              <button type="button" key={id} className="footer__link" onClick={() => goToSection(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="footer__col">
            <div className="footer__heading">Contato</div>
            <div>{settings.whatsapp}</div>
            <div className="footer__muted">{settings.address}</div>
            <div className="footer__muted">{settings.hours}</div>
          </div>
          <div className="footer__col footer__col--small">
            <div className="footer__heading">Institucional</div>
            <div className="footer__muted">Preços e disponibilidade confirmados pela loja no atendimento.</div>
            <button type="button" className="footer__admin" onClick={openAdmin}>
              Painel administrativo (demo)
            </button>
          </div>
        </div>
        <div className="footer__bottom">
          <span>© 2026 {settings.storeName}. Todos os direitos reservados.</span>
          <span>Demonstração · dados fictícios</span>
        </div>
        {showCartBar && <div className="cart-bar-spacer" />}
      </footer>

      {showCartBar && (
        <div className="cart-bar">
          <button type="button" onClick={() => setCartOpen(true)}>
            <Icon name="shopping_bag" size={22} />
            Ver encomenda · {pluralize(count, 'item', 'itens')}
          </button>
        </div>
      )}
    </div>
  );
}

function ContactCard({ icon, tone, label, note, children }: { icon: string; tone: string; label: string; note: string; children: React.ReactNode }) {
  return (
    <div className="info-card contact-card">
      <span className={`contact-card__icon ${tone}`}>
        <Icon name={icon} size={24} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="contact-card__label">{label}</div>
        {children}
        <div className="contact-card__note">{note}</div>
      </div>
    </div>
  );
}

const PAWS: { left: string; top: string; width: string; rotate: number; opacity: number; fill: string }[] = [
  { left: '8%', top: '62%', width: '11%', rotate: -18, opacity: 0.55, fill: '#1F8C83' },
  { left: '17%', top: '76%', width: '8%', rotate: -8, opacity: 0.4, fill: '#1F8C83' },
  { left: '80%', top: '8%', width: '10%', rotate: 22, opacity: 0.45, fill: '#8A3F05' },
  { left: '70%', top: '18%', width: '7%', rotate: 12, opacity: 0.35, fill: '#8A3F05' },
  { left: '84%', top: '60%', width: '8%', rotate: 30, opacity: 0.9, fill: '#FFFFFF' },
];

function AboutArt() {
  return (
    <div aria-hidden="true" className="about-art">
      <div className="about-art__blob about-art__blob--a" />
      <div className="about-art__blob about-art__blob--b" />
      {PAWS.map((p, i) => (
        <svg key={i} viewBox="-20 -20 40 40" style={{ position: 'absolute', left: p.left, top: p.top, width: p.width, transform: `rotate(${p.rotate}deg)`, opacity: p.opacity }}>
          <g fill={p.fill}>
            <ellipse cx="0" cy="6" rx="9" ry="7.5" />
            <circle cx="-10" cy="-5" r="4" />
            <circle cx="-3.5" cy="-11" r="4" />
            <circle cx="3.5" cy="-11" r="4" />
            <circle cx="10" cy="-5" r="4" />
          </g>
        </svg>
      ))}
      <div className="about-art__center">
        <div>
          <img src={asset('assets/logo.png')} alt="" />
        </div>
      </div>
    </div>
  );
}
