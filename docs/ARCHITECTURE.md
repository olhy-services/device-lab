# Arquitetura do device-lab

O device-lab é um único processo Node que conversa com o `adb` de um lado e com uma
página React no navegador do outro. Nada é instalado no aparelho de forma permanente.

```
 Navegador (React + WebCodecs)                 Computador (Node 22)                         Android
┌───────────────────────────┐   HTTP /api/*   ┌────────────────────────────────┐   adb     ┌──────────────────────┐
│ App.tsx                   │ ──────────────▶ │ http.ts   (rotas + validação)  │ ────────▶ │ adbd                 │
│  ├ Screen  (canvas)       │                 │  ├ ops.ts / system.ts / files  │           │  ├ shell (dumpsys,   │
│  │   useMirror.ts         │ ◀═ WS screen ══ │  ├ mirror.ts  (scrcpy)  ───────┼──────────▶│  │   /proc, pm, cmd) │
│  └ DevTools (abas)        │                 │  ├ device.ts  (métricas, logcat)│          │  ├ scrcpy-server     │
│      useDeviceEvents.ts   │ ◀═ WS events ══ │  └ proxy.ts   (mockttp + CA)   │ ◀──────── │  │   (/data/local/tmp)│
└───────────────────────────┘                 └────────────────────────────────┘ adb reverse└ http_proxy global  │
                                                                                            └──────────────────────┘
```

## Pastas

| Pasta | Papel |
|---|---|
| `src/server/` | Servidor HTTP/WebSocket, integração com o `adb`, scrcpy e proxy. Roda com `tsx` (sem etapa de build). |
| `src/web/` | Interface React. Em dev é servida pelo Vite em modo middleware; em produção, de `dist/web`. |
| `src/shared/` | `schema.ts`: contratos Zod usados pelos dois lados. É a única fonte dos tipos trocados pela rede. |
| `bin/` | Ponto de entrada `device-lab` (registra o `tsx` e importa `cli.ts`). |
| `patches/` | Patch do `mockttp` para o proxy escutar só em `127.0.0.1`. |
| `landing/` | Página de apresentação estática (não faz parte do app). |

## Módulos do servidor

- **`cli.ts`**: lê os argumentos (`serve`, `devices`, `reset`), sobe o servidor e, no
  Ctrl+C, encerra espelhos e tira o proxy dos aparelhos.
- **`http.ts`**: roteador mínimo sem framework. Cada rota valida a entrada com um
  schema Zod e devolve JSON, um binário (`RawBody`) ou um fluxo de processo
  (`StreamBody`, para downloads grandes). Também faz o *upgrade* dos dois WebSockets.
- **`adb.ts`**: localiza o binário do `adb`, lista aparelhos, pareamento e conexão por
  Wi-Fi, e o `PersistentShell`: um `adb shell` aberto por aparelho que recebe vários
  comandos separados por marcadores. Isso evita abrir um processo por métrica.
- **`device.ts`**: `DeviceRegistry` guarda uma sessão por aparelho. Cada sessão coleta
  métricas 1×/s (histórico de 2 min), lê o logcat num anel de 5.000 linhas e repassa
  eventos aos inscritos. Sem ninguém inscrito por 15 s, a coleta para.
- **`parse.ts`**: funções puras que leem `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`,
  `dumpsys battery`, `dumpsys gfxinfo`, zonas térmicas, logcat e `pm`. São o que tem
  teste (`parse.test.ts`), porque o formato muda entre fabricantes e versões.
- **`mirror.ts`**: `MirrorSession` envia o `scrcpy-server` para `/data/local/tmp`, abre o
  fluxo de vídeo H.264 e o canal de controle (toque, rolagem, teclas, área de
  transferência). Vários navegadores podem assistir ao mesmo espelho.
- **`proxy.ts`**: cria a CA local em `~/.device-lab`, sobe o `mockttp`, faz
  `adb reverse` e liga o `http_proxy` global do Android. Também desfaz um proxy
  esquecido de uma execução anterior que caiu.
- **`connections.ts`**: lê `/proc/net/tcp*` e `udp*` e cruza o UID com o pacote do app.
- **`ops.ts`**, **`system.ts`**, **`files.ts`**: ações pontuais (apps, configurações,
  captura de tela, processos, liberar RAM, esfriar, arquivos com `run-as`/`su`).
- **`exec.ts`**: execução de processos com tempo limite. Todo comando ao aparelho tem
  limite, para um aparelho que "sumiu" não travar a interface.

## Canais entre servidor e navegador

| Canal | Direção | Conteúdo |
|---|---|---|
| `GET/POST /api/...` | navegador → servidor | Ações e consultas pontuais. JSON validado com Zod. |
| `WS /ws/screen/:serial` | binário servidor → navegador | Pacotes de vídeo: cabeçalho de 10 bytes `[tipo:u8][flags:u8][pts:i64]` + dados H.264. `tipo` 0 = configuração (SPS/PPS), 1 = quadro. |
| `WS /ws/screen/:serial` | texto, nos dois sentidos | Navegador manda `ControlMessage` (`touch`, `scroll`, `key`, `text`, `paste`, `button`, `keyframe`). Servidor manda `ScreenEvent` (`ready`, `size`, `clipboard`, `error`, `closed`). |
| `WS /ws/events/:serial` | servidor → navegador | `ServerEvent`: `snapshot` inicial e depois `metrics`, `logs`, `http`, `tls-failure`, `proxy`, `device-error`. |

No navegador, `useMirror.ts` entrega os pacotes ao decodificador WebCodecs
(`@yume-chan/scrcpy-decoder-webcodecs`), que desenha num `<canvas>`. As coordenadas do
mouse são convertidas para a resolução real do vídeo antes de virar toque.

## Fluxo da captura de requisições

1. `POST /api/devices/:serial/proxy/start`.
2. O `mockttp` sobe numa porta livre entre 8800 e 8899 em `127.0.0.1`, assinando
   certificados com a CA local.
3. `adb reverse tcp:<porta> tcp:<porta>` faz a porta do aparelho chegar ao computador.
4. `settings put global http_proxy 127.0.0.1:<porta>` aponta o Android para ela.
5. Cada troca HTTP vira um evento `http` no WebSocket; falha de TLS (app que não
   confia na CA ou usa pinning) vira `tls-failure`.
6. `proxy/stop`, o Ctrl+C ou a próxima abertura do aparelho desfazem os passos 3 e 4.

## Segurança

O servidor tem o poder do shell do adb, então ele se protege de outros sites abertos
no mesmo navegador:

- escuta em `127.0.0.1`;
- recusa `Host` que não seja local (DNS rebinding);
- o *upgrade* de WebSocket exige `Origin` igual ao próprio servidor (WebSocket não
  passa por CORS);
- corpo limitado (1 MiB em JSON, 1 GiB em upload de arquivo/APK, 128 KiB por mensagem
  de controle);
- argumentos que viram comando de shell (pacote, serial, caminho) passam por schema
  e são escapados.

Detalhes e como reportar falhas em [SECURITY.md](../SECURITY.md).

## Decisões

- **Sem framework HTTP.** São poucas rotas e o servidor é local; o roteador em
  `http.ts` cabe em uma tela e não traz dependências.
- **TypeScript executado com `tsx`.** O servidor não tem build; só a interface é
  empacotada pelo Vite.
- **scrcpy em vez de captura por `screencap`.** Dá vídeo de verdade (60 fps, H.264
  por hardware) e controle de entrada sem instalar app.
- **Shell persistente.** Coletar 10 métricas por segundo abrindo processos novos pesa
  no aparelho e no computador; um shell com marcadores resolve.
