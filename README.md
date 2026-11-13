# dsh-voz-pt

![dsh-voz-pt icon](./assets/icon-180.png)

**English** | [Português](./README.pt-BR.md)

**Live Brazilian Portuguese dictation for DeepSeek Harness.** Speak and watch the
text appear and correct itself in the composer draft — then review and send.
Everything runs locally.

Two modes:

1. **Live** — the plugin's own **mic + PT** button in the composer toolbar.
   A streaming Portuguese Zipformer model returns partial hypotheses about once a
   second, and the draft is updated in real time.
2. **Official provider** — the DSH voice-input microphone (right side of the
   composer) records first and transcribes after you stop, using local Whisper.

Nothing is sent automatically. Audio never leaves your machine.

## Live dictation

- **mic + PT** button in the composer tool row, next to the paste-image button.
- Streaming Zipformer model: partial text every ~1 s; a phrase closes after
  ~1.2 s of silence.
- The final text replaces the last partial hypothesis. If you edit while
  dictating, the plugin stops overwriting and inserts subsequent phrases at the
  caret instead.
- Click the button again (stop icon) to finish. The text stays in the draft.
- Existing draft text is kept and the dictation is appended.
- If the draft has reference chips or attachments, the plugin inserts phrase by
  phrase instead of replacing the whole document.

## Official provider (Whisper)

- Provider `voz-pt-local`, language `pt`, default model `small-int8`.
- Local Whisper (int8, CPU), no cloud and no API key.
- Download on demand, pinned revision and SHA-256, progress in the DSH voice
  settings card.
- One inference at a time, short queue, cancellation through `AbortSignal`.

## Install

From GitHub (normal CLI/web profiles):

```sh
dsh plugin --profile <profile> add github:wgrbiss-spec/dsh-voz-pt
```

On the **Desktop app** the profile is managed by Electron and the command above
is refused. Install it from the GUI plugin manager (Settings → Plugins) or place
the package under `~/.dsh/profiles/desktop/node_modules/dsh-voz-pt` and add
`dsh-voz-pt` to `dsh.profile.bundles` in
`~/.dsh/profiles/desktop/package.json`.

Requirements: DSH `>=0.2.2-rc.1 <0.3.0`, Node 22, and the `sherpa-onnx-node`
native addon (bundled with the DSH app; installed as a dependency otherwise).

On first use the models are downloaded to `~/.dsh/voz-pt/models/`:

| id | size | use |
|---|---:|---|
| `streaming-pt` | 149 MB | live dictation (Zipformer transducer) |
| `small-int8` | 375 MB | official provider (Whisper small) |
| `base-int8` | 160 MB | faster Whisper alternative, less accurate |

## Configuration

```yaml
- id: dsh-voz-pt
  config:
    providerId: voz-pt-local
    dataRoot: !!js dshHomePath('voz-pt')
    model: small-int8          # official provider
    streamingModel: streaming-pt
    streamingEnabled: true
    threads: 4
```

## How it works

- Host: registers a `speechToText` provider (Whisper) and a
  `POST /dsh-voz-pt/stream` route (PCM16 mono 16 kHz, ~200 ms chunks, one
  in-memory session per recording).
- Client: `getUserMedia` + `ScriptProcessor`, resamples to 16 kHz, sends chunks,
  and applies hypotheses through `inputActions.setDraft` (or `insertText` when
  the draft contains chips).
- The route is fail-closed: loopback only, same origin (`Origin`/`Referer` =
  `Host`), `sec-fetch-site` not cross-site, `content-type: application/json`.
- The streaming recognizer is `sherpa-onnx` `OnlineRecognizer` with endpointing.
  The official provider uses `OfflineRecognizer` with Whisper.

## Development

```sh
npm test
npm run validate
MODEL=small-int8 node tools/smoke.mjs   # real Whisper transcription
```

The smoke test uses `.lab/audio/google.wav` and hardlinks models from
`.lab/models/`; those local fixtures are gitignored. Unit tests cover config,
manifests, WAV parsing, recognizer configs and the route guard.

## Limitations

- Experimental: DSH composer/slot APIs may change.
- The streaming weights come from
  `kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko`, which declares no license on
  HuggingFace. They are downloaded at runtime and are not redistributed here.
  Very specific jargon can still be wrong — review before sending.
- The **PT** button and the official microphone are different paths: the first
  uses the streaming model, the second uses the Whisper provider.

## License

MIT for the code (© 2026 wgrbiss-spec). Models and `sherpa-onnx` keep their
upstream licenses.
