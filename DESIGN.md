# DESIGN.md — device-lab

Ferramenta de dev, modo "operar": densa e neutra. A tela do aparelho é a protagonista
e as DevTools são instrumento.

- **Tokens** em `src/web/styles.css` (`:root`, tema escuro via `prefers-color-scheme`),
  os mesmos do gps-sim para as duas ferramentas parecerem uma família.
- **`--primary`** só na ação principal de uma área (ex.: "Capturar requisições") e no
  confirmar de diálogos não destrutivos. Ações destrutivas usam `--danger`.
- **Status** sempre com cor + texto: `--ok` (capturando, 2xx, app na tela), `--warn`
  (aviso, 4xx, aparelho não responde), `--danger` (erro, 5xx, logcat E/F).
- **Gráficos** (skill dataviz): `--series-1` azul para série única, `--series-2`
  laranja como segunda série (Recebido/Enviado). Paleta validada em claro e escuro
  (`validate_palette.js`: CVD ΔE 24,7 / 26,8). Linha de 2 px, grade de 1 px, janela fixa
  de 2 min, cursor com tooltip, legenda + valor atual quando há 2 séries. Magnitudes
  (armazenamento) em barras horizontais de uma cor só, ordenadas.
- A tela fica num retângulo escuro com cantos de 14 px e a proporção real do vídeo.
  Não há moldura de celular desenhada.
- Botões do aparelho ficam numa coluna de ícones `ghost` com `title`/`aria-label`.
- Confirmações usam `<dialog>` na página, nunca `window.confirm`.
- Sem gradientes, blur, sombras coloridas ou animação decorativa. A única animação é
  o spinner de "Abrindo a tela…", desligado com `prefers-reduced-motion`.
- Fonte do sistema; `--mono` para serial, pacotes, URLs e logcat.
