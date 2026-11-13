# Publicação

Este repositório é a fonte do plugin `dsh-voz-pt`. Para distribuir:

## 1. GitHub

O repositório público é:

```
https://github.com/wgrbiss-spec/dsh-voz-pt
```

Instalação por perfil (CLI/web):

```sh
dsh plugin --profile <perfil> add github:wgrbiss-spec/dsh-voz-pt
```

O app Desktop gerencia o próprio perfil; use **Configurações → Plugins** ou a
instalação manual descrita no README.

## 2. Catálogo comunitário

O catálogo curado é <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>.
A submissão é **um PR com um arquivo YAML** em `data/plugins/`.

Arquivo sugerido: `data/plugins/wgrbiss-spec__dsh-voz-pt.yml`

```yaml
url: https://github.com/wgrbiss-spec/dsh-voz-pt
name: wgrbiss-spec/dsh-voz-pt
category: voice
description:
  en: Live Brazilian Portuguese dictation in the DeepSeek Harness composer, with a local streaming Zipformer model and a Whisper speech-to-text provider.
  zh: 在 DeepSeek Harness 输入框中实时进行巴西葡萄牙语听写，使用本地流式 Zipformer 模型和 Whisper 语音转文字提供程序。
icon: https://raw.githubusercontent.com/wgrbiss-spec/dsh-voz-pt/main/assets/icon-180.png
```

Antes de abrir o PR: `npm test`, `npm run validate` e confira o
`npm pack --dry-run` (o pacote não inclui `.lab`, modelos, `node_modules` nem
tarballs). O repositório precisa ser público e o `package.json` precisa manter
`dsh.bundle.patch`.
