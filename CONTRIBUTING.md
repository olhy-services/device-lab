# Como contribuir

Obrigado pelo interesse! Issues e pull requests são bem-vindos.

## Preparar o ambiente

```bash
git clone https://github.com/olhy-services/device-lab.git
cd device-lab
pnpm install   # Node 22+ (veja .nvmrc). Baixa também o scrcpy-server.
pnpm dev       # http://127.0.0.1:4700, recarrega ao salvar
```

Você precisa de um Android com Depuração USB ligada (ou um emulador). Para ver o log
do scrcpy no terminal, rode com `DEVICE_LAB_DEBUG=1 pnpm dev`.

## Antes de abrir o PR

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

O CI roda esses quatro comandos e precisa passar.

## Regras do código

- **TypeScript estrito, sem `any` e sem forçar tipo** (`as X`, `!`, `@ts-ignore`).
  Só `as const` é aceito. Dado de fora (rede, saída do `adb`, JSON) entra como
  `unknown` e passa por Zod.
- **Contratos em `src/shared/schema.ts`.** Toda rota nova tem schema de entrada, e
  todo evento novo do WebSocket entra na união `ServerEventSchema` ou
  `ScreenEventSchema`. Não escreva interface à mão duplicando um schema.
- **Leitura de saída do aparelho fica em `parse.ts`, com teste.** Cole um exemplo real
  da saída (de preferência de mais de um fabricante) no teste.
- **Todo comando ao aparelho tem tempo limite** (`withTimeout` / `exec.ts`).
- **Nada de diálogos nativos** (`alert`, `confirm`). Use `ConfirmDialog`.
- **Interface:** siga o [DESIGN.md](DESIGN.md). Cor primária só na ação principal,
  status sempre com cor e texto, sem decoração (gradiente, blur, animação gratuita).
- Textos da interface e mensagens de erro em português do Brasil.

## Commits

Mensagens curtas no imperativo, descrevendo o efeito. Exemplos:
`corrige leitura de temperatura no Xiaomi`, `adiciona filtro por pacote no logcat`.

## Recursos novos

Para algo grande (uma aba nova, suporte a outro sistema), abra uma issue antes para
alinharmos o desenho. Leia [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para saber
onde cada parte mora.

Ao contribuir, você concorda que seu código seja distribuído sob a [licença MIT](LICENSE).
