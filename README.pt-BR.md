# dsh-voz-pt

![Ícone do dsh-voz-pt](./assets/icon-180.png)

**Português** | [English](./README.md)

Ditado em **português do Brasil** no DeepSeek Harness, 100% local, com dois modos:

1. **Ao vivo** — um botão de microfone próprio no compositor. O texto vai
   aparecendo e se corrigindo **enquanto você fala**, direto no rascunho, para
   você revisar antes de enviar.
2. **Provider oficial** — o botão de microfone da UI de voz do DSH grava e
   transcreve depois de parar (Whisper small). Útil para frases longas.

Nada é enviado automaticamente: o texto fica no compositor.

## Ditado ao vivo

- Botão **mic + PT** na fileira de ferramentas do compositor, ao lado do botão de
  colar imagem.
- Modelo **Zipformer streaming** em português: devolve hipóteses parciais a cada
  ~1 s e fecha a frase após ~1,2 s de silêncio.
- O rascunho é atualizado em tempo real; o texto final substitui a última
  hipótese parcial. Se você editar durante o ditado, o plugin para de
  sobrescrever e passa a inserir os próximos trechos no cursor.
- Clicar de novo (ícone de parar) finaliza e mantém o texto no rascunho.
- Se o rascunho já tiver texto, o ditado é anexado ao final.
- Se houver chips/arquivos no rascunho, o plugin insere por trechos em vez de
  substituir o documento inteiro.

## Provider oficial (Whisper)

- Provider `voz-pt-local`, idioma `pt`, modelo padrão `small-int8`.
- Transcrição local com Whisper (int8, CPU), sem nuvem e sem chave de API.
- Download sob demanda, com revisão e SHA-256 fixados, idempotente e com
  progresso na UI.
- Uma inferência por vez, com fila curta e cancelamento via `AbortSignal`.

## Instalação

### Pelo GitHub (recomendado)

```sh
dsh plugin --profile <perfil> add github:wgrbiss-spec/dsh-voz-pt
```

No **app Desktop** o perfil é gerenciado pelo Electron e o comando acima é
recusado. Instale pelo gerenciador de plugins da GUI (Configurações → Plugins) ou
deixe o pacote em `~/.dsh/profiles/desktop/node_modules/dsh-voz-pt` e inclua
`dsh-voz-pt` em `dsh.profile.bundles` de
`~/.dsh/profiles/desktop/package.json`. O bundle aplica o `cordis.patch.yml`, que
insere o provider e seleciona `voz-pt-local` + `pt` como padrão do serviço de
fala.

Requisitos: DSH `>=0.2.2-rc.1 <0.3.0`, Node 22 e o addon nativo do
`sherpa-onnx-node` (já vem no app do DSH; em instalações via npm ele é baixado
como dependência).

> Nesta máquina o plugin já está instalado no perfil `desktop`, com os modelos
> `small-int8` e `streaming-pt` em `~/.dsh/voz-pt/models/`.

## Configuração

```yaml
- id: dsh-voz-pt
  config:
    providerId: voz-pt-local
    dataRoot: !!js dshHomePath('voz-pt')
    model: small-int8          # provider oficial
    streamingModel: streaming-pt
    streamingEnabled: true
    threads: 4
```

## Modelos

| id | tamanho | uso |
|---|---:|---|
| `streaming-pt` | 149 MB | ditado ao vivo (Zipformer transducer) |
| `small-int8` | 375 MB | provider oficial (Whisper small) |
| `base-int8` | 160 MB | alternativa mais rápida e menos precisa |

Pesos baixados em runtime do HuggingFace, com commit e SHA-256 fixados em
`lib/models.js`:
- `kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko`
- `csukuangfj/sherpa-onnx-whisper-{small,base}`

Licenças do upstream: Whisper (MIT), sherpa-onnx (Apache-2.0). O repositório do
modelo streaming não declara licença; os pesos não são redistribuídos no pacote.

## Como funciona

- Host: provider `speechToText` (Whisper) + rota `POST /dsh-voz-pt/stream`
  (PCM16 mono 16 kHz em blocos de ~200 ms, sessão em memória por gravação).
- Cliente: captura com `getUserMedia`/`ScriptProcessor`, reamostra para 16 kHz,
  envia blocos e aplica as hipóteses via `inputActions.setDraft` (ou
  `insertText` quando há chips).
- A rota é fail-closed: só loopback, mesma origem (`Origin`/`Referer` = `Host`),
  `sec-fetch-site` não cross-site e `content-type: application/json`.
- Nenhum áudio é enviado para a nuvem; microfone, inferência e rascunho ficam na
  máquina.

## Limitações

- Projeto experimental: a API de slots/compositor do DSH pode mudar.
- O modelo streaming `kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko` não declara
  licença no HuggingFace; os pesos são baixados em runtime e não redistribuídos
  neste repositório. O modelo é ótimo para pt-BR, mas jargão muito específico
  ainda pode errar — revise antes de enviar.
- O botão **PT** e o microfone oficial (à direita) são caminhos diferentes: o
  primeiro usa o modelo streaming; o segundo usa o provider Whisper.

## Licença

Código MIT (© 2026 wgrbiss-spec). Modelos e `sherpa-onnx` mantêm suas licenças de
origem.

## Desenvolvimento

```sh
node tools/smoke.mjs                 # Whisper base-int8
MODEL=small-int8 node tools/smoke.mjs
```

O smoke usa `.lab/audio/google.wav` (fala pt-BR) e semeia os modelos de
`.lab/models/` por hardlink. Saída esperada para o small:
`"Preciso revisar o PUL Request antes do Merge na Brent principal."` com
RTF ~0,26 (4 threads).
