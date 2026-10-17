import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { scrollToSection } from './scroll';
import { UiContext, type UiContextValue, type WhatsAppDraft } from './contexts';

export function UiProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [cartOpen, setCartOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [wa, setWa] = useState<WhatsAppDraft | null>(null);

  // Ao alternar entre loja e painel, fecha as sobreposições da área anterior.
  const area = pathname.startsWith('/admin') ? 'admin' : 'store';
  const [lastArea, setLastArea] = useState(area);
  if (area !== lastArea) {
    setLastArea(area);
    setCartOpen(false);
    setDetailId(null);
    setWa(null);
  }

  const goToSection = useCallback(
    (id: string) => {
      if (pathname !== '/') navigate('/', { state: { section: id } });
      else scrollToSection(id);
    },
    [navigate, pathname],
  );

  const value = useMemo<UiContextValue>(
    () => ({
      cartOpen,
      setCartOpen,
      detailId,
      openDetail: setDetailId,
      closeDetail: () => setDetailId(null),
      wa,
      setWa,
      goToSection,
    }),
    [cartOpen, detailId, wa, goToSection],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
