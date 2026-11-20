# device-lab

[![CI](https://github.com/olhy-services/device-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/olhy-services/device-lab/actions/workflows/ci.yml)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Espelho de um Android no navegador, com DevTools do aparelho ao lado.

Você vê a tela do celular no navegador e usa ela com mouse e teclado. Ao lado ficam
CPU, memória, temperaturas, quadros por segundo do app aberto, processos, conexões de
rede, requisições HTTP/HTTPS, logcat, apps, arquivos e atalhos de configuração. Tudo
roda no seu computador, pelo `adb`, sem instalar nada no aparelho.

> **English:** device-lab mirrors an Android device in your browser (scrcpy + WebCodecs)
> and shows live DevTools next to it: CPU, memory, thermals, FPS, processes, network
> connections, an HTTP/HTTPS inspector, logcat, apps and files. Local-only, nothing is
> installed on the device. The UI and docs are in Brazilian Portuguese.

## Por que existe

O scrcpy espelha a tela, o Android Studio mostra o profiler, o Charles/HTTP Toolkit
captura requisições e o `adb logcat` mostra o log. Cada um numa janela, e alguns só
para o seu próprio app. O device-lab junta tudo numa página, para qualquer app do
aparelho, e funciona também pelo Wi-Fi.

## Começo rápido

Requisitos:

- **Node 22+** e **pnpm** (`corepack enable` instala o pnpm).
- **adb** (Android SDK platform-tools). É encontrado em `ANDROID_HOME` ou
  `~/Android/Sdk`; para outro lugar, defina `DEVICE_LAB_ADB`.
- **Android 5+** com Depuração USB ligada (Configurações › Sobre o telefone › toque 7×
  em Número da versão › Opções do desenvolvedor › Depuração USB).
- **Navegador com WebCodecs**: Chrome, Edge ou Firefox recentes.

```bash
git clone https://github.com/olhy-services/device-lab.git
cd device-lab
pnpm install          # baixa também o scrcpy-server 3.3.3
pnpm dev              # abre http://127.0.0.1:4700 e recarrega ao salvar
```

Para uso diário, sem recarga automática:

```bash
pnpm build && pnpm start
```

Conecte o celular no USB, aceite a chave de depuração no aparelho e escolha ele na
lista. A tela aparece em poucos segundos.

### Sem cabo

Com o cabo ligado uma vez, **Passar para Wi-Fi** faz o `adb tcpip` e conecta pelo IP.
Sem cabo nenhum (Android 11+): no celular, Opções do desenvolvedor › Depuração por
Wi-Fi › Parear com código. Em **Conectar pelo Wi-Fi** cole o IP:porta e o código do
pareamento, depois conecte no IP:porta mostrado na tela principal de Depuração por
Wi-Fi (é outra porta). Aparelhos anunciados na rede aparecem para um clique.

## Como usar

### Tela

| Ação no computador | Vira no aparelho |
|---|---|
| Clique ou arraste | Toque (multitoque em tela sensível ao toque) |
| Roda do mouse | Rolagem |
| Botão direito | Voltar |
| Botão do meio | Início |
| Teclado (com a tela em foco) | Digitação. Acentos e emoji entram colando. |
| Ctrl+V | Cola o texto daqui no aparelho. O que for copiado lá vem para cá. |

A coluna ao lado da tela tem voltar, início, recentes, notificações, volume,
liga/desliga, girar, **captura de tela** (PNG em resolução cheia) e **gravação** (WebM
do que aparece no espelho).

### DevTools

| Aba | O que mostra |
|---|---|
| Visão geral | CPU total e por núcleo (uso e frequência), RAM, swap/zram, rede, temperaturas (CPU, GPU, bateria, superfície), bateria (corrente, tensão, saúde). Botões **Liberar RAM** e **Esfriar**. |
| Desempenho | Do app aberto: quadros/s, % de quadros lentos, p90 do tempo de quadro, CPU e memória (RSS). |
| Processos | Todos os processos (`top`): CPU, memória, usuário. Busca, filtro "só apps" e **encerrar** (app: `force-stop`; outros: `kill -9`, que sem root só vale para processos do adb). |
| Rede | Volume de tráfego, **conexões de todos os apps** (`/proc/net`: app dono, servidor, porta, estado) e o **inspetor de requisições** HTTP/HTTPS (cabeçalhos, corpo, copiar como cURL). |
| Logcat | Ao vivo, por nível, com busca e filtro "só o app na tela". Pausar e limpar. |
| Apps | Lista com tamanhos. Abrir, forçar parada, apagar dados, desinstalar. Instalar APK arrastando o arquivo. |
| Arquivos | Navegar pastas (`/sdcard`, `/system`, `/proc`…), ver texto e imagens, baixar, enviar, apagar. "Ler como" abre a pasta privada (`/data/data/<app>`) de apps de debug via `run-as`; com root, usa `su`. |
| Armazenamento | Uso total, por tipo e os apps que mais ocupam. |
| Ferramentas | Abrir link ou deep link, tirar água do alto-falante (tom de 165 Hz), tema escuro, tamanho da fonte, mostrar toques, limites de layout, rotação, tela sempre ligada. |

### Requisições HTTPS

**Capturar requisições** sobe um proxy ([mockttp](https://github.com/httptoolkit/mockttp))
em `127.0.0.1`, liga o aparelho a ele por `adb reverse` e aponta o proxy do Android
para ele (`settings put global http_proxy`). **Parar captura** desfaz tudo.

- HTTP aparece direto.
- Para ver HTTPS, o aparelho precisa confiar na CA do device-lab. Ela é criada uma vez
  em `~/.device-lab/ca.pem` e copiada para `Download/device-lab-ca.crt` no aparelho.
  Instale em Configurações › Segurança › Criptografia e credenciais › Instalar
  certificado › Certificado CA.
- Desde o Android 7, apps só confiam em CA de usuário se permitirem. Na build de debug
  do seu app, em `res/xml/network_security_config.xml`:

  ```xml
  <network-security-config>
    <debug-overrides>
      <trust-anchors>
        <certificates src="user" />
      </trust-anchors>
    </debug-overrides>
  </network-security-config>
  ```

- Apps de terceiros e apps com *certificate pinning* aparecem como "recusou o
  certificado". É o esperado: para eles é preciso root (CA no repositório do sistema)
  ou desligar o pinning com Frida/objection.
- O Chrome confia em CA de usuário, então com a CA instalada o tráfego dele aparece.
- A aba **Conexões** mostra o destino de tudo, inclusive de quem ignora o proxy
  (WhatsApp, QUIC/HTTP3, protocolos próprios), mas não o conteúdo.

## Linha de comando

```bash
pnpm start                       # o mesmo que "serve"
pnpm start -- --port 4800        # outra porta
pnpm start -- --no-open          # não abre o navegador
pnpm start devices               # lista aparelhos e se estão prontos
pnpm start reset <serial>        # tira o proxy do aparelho
```

Para ter o comando `device-lab` no terminal: `pnpm link --global`.

| Variável | Para quê | Padrão |
|---|---|---|
| `DEVICE_LAB_ADB` | Caminho do `adb` | `ANDROID_HOME` ou `~/Android/Sdk` |
| `DEVICE_LAB_HOME` | Onde ficam a CA e a chave do proxy | `~/.device-lab` |
| `DEVICE_LAB_DEBUG` | Mostra o log do scrcpy no terminal | desligado |

## Arquitetura

Um processo Node conversa com o `adb` e serve uma página React. A tela vem do
[scrcpy](https://github.com/Genymobile/scrcpy) como H.264 por WebSocket e é decodificada
no navegador com WebCodecs. Métricas e logcat saem de um `adb shell` persistente por
aparelho e chegam por um segundo WebSocket. Todos os contratos entre servidor e
navegador são schemas Zod em `src/shared/schema.ts`.

```
Navegador ──HTTP /api/*──▶ Servidor Node ──adb──▶ Android
          ◀═WS screen════  (scrcpy, métricas,      (scrcpy-server temporário,
          ◀═WS events════   logcat, proxy)          shell, http_proxy)
```

Detalhes de cada módulo, do protocolo do vídeo e do fluxo do proxy em
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/
├── server/   cli, http (rotas), adb, device (métricas/logcat), mirror (scrcpy),
│             proxy (mockttp + CA), parse (+ testes), ops, system, files, connections
├── web/      App, componentes, abas das DevTools, useMirror, useDeviceEvents
└── shared/   schema.ts (contratos Zod)
```

## Coisas para saber

- **Só o computador local.** O servidor escuta em `127.0.0.1`, recusa `Host` estranho
  (DNS rebinding) e só aceita comandos e WebSocket vindos da própria página. O proxy
  também só escuta em `127.0.0.1` (patch em `patches/mockttp@4.6.5.patch`). Veja
  [SECURITY.md](SECURITY.md).
- **Se o device-lab cair capturando requisições**, o celular fica com um proxy que não
  existe mais e sem internet. O device-lab tira esse proxy na próxima vez que abre o
  aparelho; à mão, `pnpm start reset <serial>`.
- **Aparelho que "sumiu"** (Wi-Fi caiu, economia de energia): todo comando tem tempo
  limite e a interface mostra "O aparelho não responde". Use **Desconectar** e
  conecte de novo.
- **Quadros/s** vêm do `dumpsys gfxinfo` (Views, Compose, React Native). Flutter,
  jogos e SurfaceView aparecem como 0. Ler essa medida zera as estatísticas de quadros
  do app (`gfxinfo reset`).
- **Girar** trava a rotação no sentido oposto (`wm user-rotation lock`) e desliga o
  giro automático. Para voltar, ligue "Girar automaticamente" em Ferramentas.
- **Esfriar** encerra apps em segundo plano, liga a economia de bateria e baixa o
  brilho. O estado anterior fica em `/data/local/tmp/device-lab-cool-state` no
  aparelho, para o "desfazer" funcionar mesmo depois de reiniciar o device-lab.
- **Tirar água** toca 30 s de 165 Hz no volume máximo. Só ajuda no alto-falante.
- Sem mudança na tela o encoder não manda quadros: o espelho fica parado até algo
  mudar. É normal.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "adb não encontrado" | Instale o platform-tools ou defina `DEVICE_LAB_ADB=/caminho/do/adb`. |
| Aparelho aparece como "unauthorized" | Desbloqueie o celular e aceite a chave de depuração. |
| Tela preta | Navegador sem WebCodecs, ou o aparelho está com a tela apagada. Toque nela. |
| Celular sem internet depois de usar | `pnpm start reset <serial>`. |
| HTTPS de um app aparece como "recusou o certificado" | Veja [Requisições HTTPS](#requisições-https). |

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Antes de abrir um PR:
`pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Créditos

- [scrcpy](https://github.com/Genymobile/scrcpy) (Apache 2.0), baixado na instalação e
  enviado ao aparelho só durante o espelhamento.
- [Tango / ya-webadb](https://github.com/yume-chan/ya-webadb) (MIT), cliente do adb e
  do scrcpy em TypeScript.
- [mockttp](https://github.com/httptoolkit/mockttp) (Apache 2.0), proxy HTTP/HTTPS.

## Licença

[MIT](LICENSE) © Olhy Tecnologia e contribuidores.
