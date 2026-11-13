/**
 * Metade browser do dsh-voz-pt: botão de ditado ao vivo no compositor.
 *
 * Captura o microfone em PCM16 mono 16 kHz, manda blocos de ~200 ms para
 * `/dsh-voz-pt/stream` e vai atualizando o rascunho com as hipóteses parciais
 * do modelo streaming. Nada é enviado: o texto fica no compositor para revisão.
 */

window.__ModuleLoader__.load({
  id: "dsh-voz-pt",
  factory: (require) => {
    const React = require("react")
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const ENDPOINT = "/dsh-voz-pt/stream"
    const CHUNK_SAMPLES = 3200 // 200 ms a 16 kHz

    const MIC_ICON = "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a1 1 0 0 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.92V21h2a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h2v-3.08A6 6 0 0 1 6 12Z"
    const STOP_ICON = "M7 7h10v10H7z"

    function icon(path) {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", focusable: "false" },
        h("path", { d: path, fill: "currentColor" }),
      )
    }

    function bytesToBase64(bytes) {
      let binary = ""
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    /** Float32 [-1,1] -> PCM16 LE. */
    function pcm16(samples) {
      const buffer = new ArrayBuffer(samples.length * 2)
      const view = new DataView(buffer)
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(i * 2, Math.round(value * 32767), true)
      }
      return new Uint8Array(buffer)
    }

    /** Reamostra para 16 kHz por média de janelas (suficiente para ASR). */
    function downsample(input, inputRate, outputRate) {
      if (inputRate === outputRate) return input
      const ratio = inputRate / outputRate
      const length = Math.max(1, Math.floor(input.length / ratio))
      const output = new Float32Array(length)
      for (let i = 0; i < length; i += 1) {
        const start = Math.floor(i * ratio)
        const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
        let sum = 0
        for (let j = start; j < end; j += 1) sum += input[j]
        output[i] = sum / (end - start)
      }
      return output
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function errorText(error) {
      if (!error) return "Falha no ditado."
      if (error.name === "NotAllowedError") return "Permissão do microfone negada."
      if (error.name === "NotFoundError") return "Nenhum microfone encontrado."
      if (error.status === 403) return "O host recusou a conexão local."
      if (error.status === 409) return "O modelo ainda está sendo preparado."
      return error.message || String(error)
    }

    function LiveMic({ inputActions, useInput, sessionId }) {
      const input = useInput((state) => state)
      const inputRef = useRef(input)
      inputRef.current = input

      const [phase, setPhase] = useState("idle")
      const [status, setStatus] = useState("")
      const phaseRef = useRef("idle")
      const setPhaseBoth = (value) => {
        phaseRef.current = value
        setPhase(value)
      }

      const base = useRef("")
      const committed = useRef("")
      const partial = useRef("")
      const lastWritten = useRef("")
      const mode = useRef("replace")
      const streamId = useRef("")
      const pending = useRef([])
      const draining = useRef(false)
      const stopRequested = useRef(false)
      const stopResolve = useRef(null)
      const audio = useRef({ ctx: null, media: null, source: null, processor: null })
      const sampleBuffer = useRef(new Float32Array(CHUNK_SAMPLES))
      const sampleLength = useRef(0)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          void abort(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      function updateStatus(text) {
        if (mounted.current) setStatus(text)
      }

      function applyLive() {
        if (mode.current !== "replace") return
        const current = inputRef.current
        if (!current || current.phase !== "plain") return
        if (current.draft !== lastWritten.current) {
          // A pessoa editou durante o ditado: não sobrescreve mais o rascunho.
          mode.current = "append"
          return
        }
        const text = [committed.current, partial.current].filter(Boolean).join(" ").trim()
        const prefix = base.current ? base.current.replace(/\s+$/u, "") : ""
        const desired = prefix && text ? `${prefix} ${text}` : prefix || text
        if (desired === lastWritten.current) return
        try {
          inputActions.setDraft(desired)
          lastWritten.current = desired
          inputActions.persistDraft()
        } catch {
          // O compositor pode estar bloqueado; a próxima resposta tenta de novo.
        }
      }

      function insertFinal(text) {
        const value = String(text ?? "").trim()
        if (!value) return
        try {
          inputActions.insertText(`${value} `, inputActions.captureInsertion())
        } catch {
          // sem cursor disponível: mantém o texto só no estado interno
        }
      }

      function commit(text) {
        const value = String(text ?? "").trim()
        if (!value) return
        const previous = committed.current.trim()
        committed.current = previous ? `${previous} ${value}` : value
        if (mode.current === "append") insertFinal(value)
      }

      function handleResponse(data) {
        if (!data) return
        if (data.endpoint) {
          const finalText = String(data.text ?? partial.current ?? "").trim()
          partial.current = ""
          if (finalText) commit(finalText)
        } else {
          partial.current = String(data.text ?? "").trim()
        }
        applyLive()
      }

      async function post(action, audioBytes) {
        const body = { action, id: streamId.current }
        if (audioBytes !== undefined) body.audioBase64 = bytesToBase64(audioBytes)
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        let data = {}
        try {
          data = await response.json()
        } catch {
          data = {}
        }
        if (!response.ok) {
          const error = new Error(data.message || data.error || `HTTP ${response.status}`)
          error.status = response.status
          error.data = data
          throw error
        }
        return data
      }

      async function drain() {
        if (draining.current) return
        draining.current = true
        try {
          for (;;) {
            if (pending.current.length > 0) {
              const chunk = pending.current.shift()
              const data = await post("audio", chunk)
              handleResponse(data)
              continue
            }
            if (stopRequested.current) {
              const data = await post("stop")
              finishStop(data)
              break
            }
            break
          }
        } catch (error) {
          fail(error)
        } finally {
          draining.current = false
        }
      }

      function pushChunk(samples) {
        if (samples.length === 0) return
        pending.current.push(pcm16(samples))
        void drain()
      }

      function pushSamples(samples) {
        for (let i = 0; i < samples.length; i += 1) {
          sampleBuffer.current[sampleLength.current] = samples[i]
          sampleLength.current += 1
          if (sampleLength.current >= CHUNK_SAMPLES) {
            const chunk = sampleBuffer.current.slice(0, CHUNK_SAMPLES)
            sampleBuffer.current = new Float32Array(CHUNK_SAMPLES)
            sampleLength.current = 0
            pushChunk(chunk)
          }
        }
      }

      function flushSamples() {
        if (sampleLength.current === 0) return
        const chunk = sampleBuffer.current.slice(0, sampleLength.current)
        sampleLength.current = 0
        pushChunk(chunk)
      }

      function teardownAudio() {
        const state = audio.current
        try {
          state.processor?.disconnect()
          state.source?.disconnect()
          state.media?.getTracks?.().forEach((track) => track.stop())
          void state.ctx?.close?.()
        } catch {
          // ignore
        }
        audio.current = { ctx: null, media: null, source: null, processor: null }
      }

      function resetState() {
        pending.current = []
        stopRequested.current = false
        streamId.current = ""
        committed.current = ""
        partial.current = ""
        sampleLength.current = 0
      }

      function finishStop(data) {
        const finalText = String(data?.text ?? partial.current ?? "").trim()
        if (finalText) {
          if (mode.current === "replace") {
            partial.current = finalText
            applyLive()
          } else {
            insertFinal(finalText)
          }
        }
        teardownAudio()
        const resolve = stopResolve.current
        stopResolve.current = null
        resetState()
        if (mounted.current) {
          setPhaseBoth("idle")
          setStatus("")
        }
        resolve?.()
      }

      function fail(error) {
        teardownAudio()
        const resolve = stopResolve.current
        stopResolve.current = null
        resetState()
        if (!mounted.current) return
        setPhaseBoth("error")
        setStatus(errorText(error))
        if (console?.warn) console.warn("[dsh-voz-pt] ditado ao vivo:", error)
        resolve?.()
      }

      async function startAudio() {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        const AudioCtor = window.AudioContext || window.webkitAudioContext
        let ctx
        try {
          ctx = new AudioCtor({ sampleRate: 16000 })
        } catch {
          ctx = new AudioCtor()
        }
        await ctx.resume?.()
        const source = ctx.createMediaStreamSource(media)
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processor.onaudioprocess = (event) => {
          if (stopRequested.current) return
          const frame = event.inputBuffer.getChannelData(0)
          pushSamples(downsample(frame, ctx.sampleRate, 16000))
        }
        source.connect(processor)
        processor.connect(ctx.destination)
        audio.current = { ctx, media, source, processor }
      }

      async function start() {
        if (phaseRef.current !== "idle" && phaseRef.current !== "error") return
        const snapshot = inputRef.current
        if (!snapshot || snapshot.phase !== "plain") {
          setPhaseBoth("error")
          setStatus("Aguarde o envio atual terminar.")
          return
        }
        setPhaseBoth("starting")
        updateStatus("iniciando…")
        base.current = snapshot.draft ?? ""
        lastWritten.current = snapshot.draft ?? ""
        committed.current = ""
        partial.current = ""
        mode.current = snapshot.occurrences?.length || snapshot.attachmentIds?.length ? "append" : "replace"
        streamId.current = crypto.randomUUID?.() ?? `voz-${Date.now()}-${Math.random().toString(16).slice(2)}`
        try {
          for (let attempt = 0; attempt < 240; attempt += 1) {
            try {
              await post("start")
              break
            } catch (error) {
              if (error.status === 409 && attempt < 239) {
                const state = error.data?.state
                const progress =
                  state?.state === "downloading" && state.totalBytes
                    ? ` ${Math.round((state.progressBytes / state.totalBytes) * 100)}%`
                    : ""
                updateStatus(`preparando modelo…${progress}`)
                await sleep(1500)
                continue
              }
              throw error
            }
          }
          await startAudio()
          setPhaseBoth("recording")
          updateStatus("")
        } catch (error) {
          try {
            await post("stop")
          } catch {
            // ignora
          }
          fail(error)
        }
      }

      async function stop() {
        if (phaseRef.current !== "recording" && phaseRef.current !== "starting") return
        setPhaseBoth("stopping")
        updateStatus("finalizando…")
        stopRequested.current = true
        teardownAudio()
        flushSamples()
        await new Promise((resolve) => {
          stopResolve.current = resolve
          void drain()
        })
      }

      async function abort(restore) {
        const wasReplace = mode.current === "replace"
        stopRequested.current = true
        teardownAudio()
        if (streamId.current) {
          const id = streamId.current
          try {
            await fetch(ENDPOINT, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "stop", id }),
            })
          } catch {
            // ignore
          }
        }
        if (restore && wasReplace && inputRef.current?.draft === lastWritten.current) {
          try {
            inputActions.setDraft(base.current)
            inputActions.persistDraft()
          } catch {
            // ignore
          }
        }
        resetState()
        if (mounted.current) {
          setPhaseBoth("idle")
          setStatus("")
        }
      }

      const active = phase === "recording" || phase === "starting" || phase === "stopping"
      const busy = phase === "starting" || phase === "stopping"
      const disabled = busy || (input?.phase !== "plain" && !active)
      const label =
        phase === "recording"
          ? "Parar ditado em português"
          : phase === "stopping"
            ? "Finalizando transcrição"
            : phase === "error"
              ? `Ditado em português — ${status || "erro"}`
              : "Ditar em português ao vivo"

      const buttonStyle = {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "auto",
        minWidth: 28,
        height: 28,
        padding: "0 7px",
        gap: 4,
        border: "none",
        borderRadius: 14,
        background: active ? "var(--dsw-alias-state-success-primary, #16a34a)" : "transparent",
        color: active ? "#fff" : "var(--dsw-alias-label-secondary, #666)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        flex: "none",
      }

      return h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } },
        h(
          "button",
          {
            type: "button",
            title: label,
            "aria-label": label,
            "aria-pressed": phase === "recording",
            "data-dsh-voz-pt-live": phase,
            disabled,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              if (phase === "recording") void stop()
              else if (phase === "idle" || phase === "error") void start()
            },
            style: buttonStyle,
          },
          icon(phase === "recording" ? STOP_ICON : MIC_ICON),
          h(
            "span",
            { style: { fontSize: 10, fontWeight: 600, letterSpacing: "0.02em", lineHeight: 1 } },
            "PT",
          ),
        ),
        status
          ? h(
              "span",
              {
                role: "status",
                title: status,
                style: {
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 11,
                  color:
                    phase === "error"
                      ? "var(--dsw-alias-state-error-primary, #e5484d)"
                      : "var(--dsw-alias-label-tertiary, #888)",
                },
              },
              status,
            )
          : null,
      )
    }

    const inject = ["slots"]

    function apply(ctx) {
      return ctx.effect(() =>
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register(
            { name: "conversation.input.left", id: "dsh-voz-pt-live", order: 40 },
            LiveMic,
          ),
        ),
      )
    }

    return { apply, inject }
  },
})
