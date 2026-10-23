import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { asset } from '../../components/productArt';

/** Moldura das telas de acesso ao painel (login, verificação, acesso negado). */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Painel · Mundo das Patas`;
    return () => {
      document.title = 'Mundo das Patas';
    };
  }, [title]);

  return (
    <div className="auth-page" data-screen-label="Acesso ao painel">
      <main className="auth-card">
        <img className="auth-card__logo" src={asset('assets/logo.png')} alt="Mundo das Patas" />
        <p className="auth-card__eyebrow">Painel administrativo</p>
        <h1 className="auth-card__title">{title}</h1>
        {children}
        <Link to="/" className="btn btn--link auth-card__back">
          <Icon name="arrow_back" size={18} />
          Voltar à loja
        </Link>
      </main>
      <p className="auth-page__env">Ambiente de desenvolvimento</p>
    </div>
  );
}
