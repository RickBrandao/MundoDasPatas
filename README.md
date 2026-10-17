# Mundo das Patas — demonstração

Loja demonstrativa (catálogo + encomenda pelo WhatsApp simulada) e painel administrativo
(produtos, categorias, estoque, vendas e configurações), com **dados fictícios** salvos apenas no navegador.

Implementação em React + Vite + TypeScript do protótipo aprovado no Claude Design
(referência em `docs/reference/`).

URL prevista: https://rickbrandao.github.io/MundoDasPatas/

## Comandos

```bash
npm install
npm run dev        # http://localhost:5173/MundoDasPatas/
npm test           # Vitest (regras, persistência e integração)
npm run lint
npm run build      # gera dist/ com base /MundoDasPatas/
npm run preview    # serve o build localmente
```

## Estrutura

```
src/
  app/          inicialização, rotas (HashRouter), provedores de estado, escolha dos serviços
  components/   Icon, Modal (pilha de Esc + foco), Field, rótulos de status, caminhos de imagens
  domain/       tipos e regras puras: dinheiro em centavos, telefone, catálogo, encomenda,
                operações (produtos, estoque, vendas, estornos, categorias, configurações), relatórios
  data/         dados fictícios (seed)
  services/     contrato StoreApi + implementação local (localStorage) + validação do formato salvo
  features/     catalog, cart (encomenda + WhatsApp), admin, products, categories, inventory, sales, settings
  styles/       tokens de design e CSS por área
public/assets/  logotipo, banner e as 25 ilustrações SVG (19 produtos + 6 categorias)
```

## Regras de dados

- Valores monetários em **centavos inteiros**; entrada e exibição em reais (`49,90`, `1.234,56`).
- Estoque nunca negativo; venda confirmada reduz estoque; cancelamento devolve o estoque **uma única vez**.
- Encomenda sincronizada automaticamente com estoque, publicação, categorias e configurações.
- Produtos ocultos, arquivados ou de categorias inativas não aparecem no catálogo.
- Dados salvos validados ao carregar; se estiverem corrompidos, a demo recomeça com os dados fictícios.
- Falha ao gravar no navegador é avisada no painel; as alterações valem até recarregar.

## Backend futuro

A interface depende apenas do contrato `StoreApi` (`src/services/storeApi.ts`).
Para usar uma API (ex.: FastAPI), crie outra implementação desse contrato e troque-a em
`src/app/services.ts`. As funções de `src/domain/operations.ts` documentam as regras que o backend
deve reproduzir.

## WhatsApp

A demo **não envia mensagens**: mostra a mensagem editável, a prévia e o link `wa.me` gerado.
Para habilitar o redirecionamento real, altere `WHATSAPP_REDIRECT_ENABLED` em `src/domain/whatsapp.ts`
depois de cadastrar o número oficial em Configurações. Encomendas nunca geram venda automaticamente.

## Publicação

O workflow `.github/workflows/deploy.yml` roda lint, testes e build a cada push na `main` e publica `dist/`
no GitHub Pages. É preciso ativar em **Settings → Pages → Source: GitHub Actions**.
GitHub Pages em repositório **privado** exige plano pago (Pro/Team/Enterprise); no plano gratuito,
só repositórios públicos.
